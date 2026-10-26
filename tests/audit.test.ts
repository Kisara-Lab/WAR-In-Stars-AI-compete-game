import { response } from './helpers/responses.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { ModelProvider } from '../src/server/provider.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';
import { readJournal } from '../src/server/audit.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config = { base: 'https://audit.invalid/v1', key: 'audit-private-key' };
async function fixture(provider?: ModelProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'stars-audit-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const pool = new SimulationPool(0);
  const runner = new MatchRunner(createGame({ ...structuredClone(DEFAULT_CONFIG), maxRounds: 2, controller: provider ? 'model' : 'scripted' }), pool, new MatchStore(directory), async () => provider!);
  cleanup.push(() => runner.close().catch(() => {}));
  await runner.initialize();
  return runner;
}
const completed = () => response([
  { type: 'reasoning', encrypted_content: 'DO_NOT_RECORD_REASONING', summary: [{ text: 'PRIVATE_REASONING' }] },
  { type: 'message', content: [{ type: 'output_text', text: '公开说明'.repeat(600) + config.key }] },
  { type: 'function_call', name: 'submit_turn', call_id: 'policy', arguments: JSON.stringify({ orders: [{ type: 'choose_policy', args: { policy: 'balanced' } }], summary: `建设民生 ${config.key}` }) },
], { input_tokens: 11, output_tokens: 12, total_tokens: 23 });

describe('统一审计与提交事实', () => {
  it('重启对账标记未提交尝试，立即暂停也不会开始一轮', async () => {
    const runner = await fixture();
    runner.start(); runner.pause(); await runner.waitIdle();
    expect(runner.state.round).toBe(0);
    await runner.store.audit(runner.state.id, { category: 'attempt.started', day: 0, round: 1, attemptId: 'crashed-attempt', data: { stateHash: stateHash(runner.state) } });
    const checkpoint = await runner.store.load(runner.state.id);
    await runner.recover(checkpoint);
    expect(runner.status.phase).toBe('paused');
    const logs = await runner.store.auditRecords(runner.state.id);
    expect(logs.some(record => record.category === 'attempt.aborted' && record.attemptId === 'crashed-attempt')).toBe(true);
    expect(logs.some(record => record.category === 'runtime.recovered')).toBe(true);
  });

  it('失败和重试使用不同尝试ID，记录完整公开输入输出且统一脱敏', async () => {
    let fail = true;
    const provider = new ModelProvider(config, async () => fail ? new Response(JSON.stringify({ error: { message: `bad ${config.key}` } }), { status: 400 }) : completed());
    const runner = await fixture(provider);
    const initialHash = stateHash(runner.state);
    runner.start(true); await runner.waitIdle();
    expect(runner.status.phase).toBe('error');
    expect(stateHash(runner.state)).toBe(initialHash);
    fail = false;
    runner.start(true); await runner.waitIdle();
    expect(runner.state.round).toBe(1);
    const logs = await runner.store.auditRecords(runner.state.id);
    const attempts = logs.filter(record => record.category === 'attempt.started');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId);
    expect(logs.some(record => record.category === 'model.failure')).toBe(true);
    expect(logs.some(record => record.category === 'model.tool')).toBe(true);
    expect(logs.filter(record => record.category === 'economy.step')).toHaveLength(40);
    const source = logs.find(record => record.category === 'model.request')!.data as { body: { input: { content: string }[] } };
    expect(JSON.parse(source.body.input[0].content).faction.resources).toBeDefined();
    const output = logs.find(record => record.category === 'model.response' && (record.data as { httpStatus: number }).httpStatus === 200)!.data;
    expect(JSON.stringify(output)).toContain('公开说明'.repeat(600));
    const exported = await runner.store.exportAudit(runner.state.id);
    expect(exported).not.toContain(config.key);
    expect(exported).not.toContain('DO_NOT_RECORD_REASONING');
    expect(exported).not.toContain('PRIVATE_REASONING');
    expect(exported).not.toContain('Authorization');
    const page = await runner.store.queryAudit(runner.state.id, { attemptId: attempts[0].attemptId });
    expect(page.records.every(record => record.committed === false)).toBe(true);
    const committed = await runner.store.queryAudit(runner.state.id, { attemptId: attempts[1].attemptId });
    expect(committed.records.every(record => record.committed === true)).toBe(true);
    const round = await readFile(join(runner.store.root, runner.state.id, 'round-0001.json'), 'utf8');
    expect(round).not.toContain(config.key);
    const markdown = await runner.store.exportChronicle(runner.state.id);
    expect(markdown).toContain('未提交，不作为历史事实');
    expect(markdown).toContain('审计 #');
    expect(await runner.store.exportChronicle(runner.state.id)).toBe(markdown);
  });

  it('实际重试次数与错误均落盘，暂停请求仍有未提交结束记录', async () => {
    let calls = 0;
    const provider = new ModelProvider(config, async () => ++calls === 1 ? new Response('{"error":{"message":"rate limit"}}', { status: 429 }) : completed());
    const runner = await fixture(provider);
    runner.start(true); await runner.waitIdle();
    expect(runner.status.error).toBeNull();
    const logs = await runner.store.auditRecords(runner.state.id);
    expect(logs.filter(record => record.category === 'model.retry')).toHaveLength(1);
    expect(logs.filter(record => record.category === 'model.request')).toHaveLength(5);
    const pendingProvider = new ModelProvider(config, async (_url, init) => {
      await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
      return completed();
    });
    const pending = await fixture(pendingProvider);
    pending.start(); await new Promise(resolve => setTimeout(resolve, 60)); pending.pause(); await pending.waitIdle();
    expect(pending.state.round).toBe(0);
    expect((await pending.store.auditRecords(pending.state.id)).some(record => record.category === 'attempt.aborted')).toBe(true);
  });

  it('回合文件为权威，检查点落后或缺失可恢复；分支保留来源', async () => {
    const runner = await fixture();
    const id = runner.state.id;
    const cacheFile = join(runner.store.root, id, 'checkpoint.json');
    const initial = await readFile(cacheFile, 'utf8');
    runner.start(true); await runner.waitIdle();
    await writeFile(cacheFile, initial);
    expect((await runner.store.load(id)).state.round).toBe(1);
    await rm(cacheFile);
    expect((await runner.store.load(id)).hash).toBe(stateHash(runner.state));
    await runner.load(id);
    expect(runner.state.lineage).toMatchObject({ matchId: id, round: 1, version: 4 });
    expect((await runner.store.auditRecords(runner.state.id)).some(record => record.category === 'match.branch')).toBe(true);
  });

  it('超过1500条记录不截断，分页和过滤保持稳定，哈希链可发现损坏', async () => {
    const runner = await fixture();
    await runner.store.auditMany(runner.state.id, Array.from({ length: 1605 }, (_, index) => ({ category: 'event.population', day: index * 10, round: 1, factionId: 'aurora', systemId: 's0', data: { index } })));
    const page = await runner.store.queryAudit(runner.state.id, { category: 'event.population', factionId: 'aurora', systemId: 's0', fromDay: 1000, toDay: 2000, limit: 30 });
    expect(page.records).toHaveLength(30); expect(page.matched).toBe(101); expect(page.next).not.toBeNull();
    const next = await runner.store.queryAudit(runner.state.id, { after: page.next!, category: 'event.population', limit: 30 });
    expect(next.records[0].seq).toBe(page.records.at(-1)!.seq + 1);
    const path = join(runner.store.root, runner.state.id, 'audit.jsonl');
    const content = await readFile(path, 'utf8');
    expect((await readJournal(path)).length).toBeGreaterThan(1500);
    await writeFile(path, content.replace('event.population', 'event.corrupted'));
    await expect(readJournal(path)).rejects.toThrow('哈希链损坏');
    await writeFile(path, content);
  });

  it('审计磁盘写入失败停止比赛，不提交模拟状态', async () => {
    const runner = await fixture();
    const hash = stateHash(runner.state);
    const original = runner.store.auditMany.bind(runner.store);
    runner.store.auditMany = async () => { throw new Error('disk full'); };
    runner.start(true); await runner.waitIdle();
    expect(runner.status.phase).toBe('error');
    expect(runner.status.error).toContain('disk full');
    expect(stateHash(runner.state)).toBe(hash);
    runner.store.auditMany = original;
    runner.start(true); await runner.waitIdle();
    expect(runner.state.round).toBe(1);
  });

  it('回合原子提交后检查点失败，不回退或重复执行已提交回合', async () => {
    const runner = await fixture();
    const save = runner.store.save.bind(runner.store);
    runner.store.save = async () => { throw new Error('checkpoint cache unavailable'); };
    runner.start(true); await runner.waitIdle();
    expect(runner.status.phase).toBe('error');
    expect(runner.state.round).toBe(1);
    expect((await runner.store.load(runner.state.id)).state.round).toBe(1);
    runner.store.save = save;
    runner.start(true); await runner.waitIdle();
    expect(runner.state.round).toBe(2);
  });

  it('模拟事件批次在前端截断前完整送达，纯模拟不依赖记录器', async () => {
    const state = createGame();
    const home = state.systems[0];
    for (let index = 0; index < 1510; index++) home.projects.push({ id: `survey-${index}`, kind: 'survey', ownerId: 'aurora', planetId: null, structureType: null, shipType: null, progress: 499000, requiredDays: 500, cost: { energy: 0, food: 0, minerals: 50000 }, createdDay: 0 });
    const pool = new SimulationPool(0); cleanup.push(() => pool.close());
    let recorded = 0;
    const final = await advanceRound(state, pool, {}, async batch => { recorded += batch.events.filter(event => event.type === 'exploration').length; });
    expect(recorded).toBe(1510);
    expect(final.events).toHaveLength(1500);
  });
});
