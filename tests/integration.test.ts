import { response, endCall, batchCall } from './helpers/responses.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import type { GameState } from '../src/shared/types.js';
import { emptyMetrics, scriptedDecision } from '../src/sim/bot.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { createApplication } from '../src/server/app.js';
import { ModelProvider, readProviderConfig } from '../src/server/provider.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const surveyTarget = createGame().systems[0].neighbors[0];
const fakeConfig = { base: 'https://provider.invalid/v1', key: 'private-test-secret' };


async function fixture(controller: 'scripted' | 'model' = 'scripted', provider = new ModelProvider(fakeConfig, async () => response([endCall()]))): Promise<MatchRunner> {
  const directory = await mkdtemp(join(tmpdir(), 'war-in-stars-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const pool = new SimulationPool(0);
  const runner = new MatchRunner(createGame({ ...structuredClone(DEFAULT_CONFIG), maxRounds: 2, controller }), pool, new MatchStore(directory), async () => provider);
  cleanup.push(() => runner.close());
  await runner.initialize();
  return runner;
}

describe('Responses 工具协议', () => {
  it('普通V4恢复保留修订，显式4.2分支保留来源且不追补', async () => {
    const runner = await fixture();
    runner.state.rulesRevision = '4.1'; runner.state.day = 700; runner.state.round = 7;
    runner.state.id += '-legacy';
    await runner.initialize();
    const sourceId = runner.state.id;
    const original = await runner.store.load(sourceId);
    await runner.load(sourceId);
    expect(runner.state.rulesRevision).toBe('4.1');
    await runner.load(sourceId, undefined, '4.2');
    expect(runner.state.rulesRevision).toBe('4.2');
    expect(runner.state.balanceStartedDay).toBe(700);
    expect(runner.state.civilizationAwards).toEqual([]);
    expect(runner.state.systems.every(system => !system.annexation)).toBe(true);
    expect(runner.state.lineage?.hash).toBe(original.hash);
    expect(runner.status.phase).toBe('paused');
    expect((await runner.store.load(sourceId)).hash).toBe(original.hash);
  });
  it('模型输入统一凝聚力显示单位并按修订只给出一种评分公式', async () => {
    const bodies: { instructions: string; input: { content: string }[] }[] = [];
    const provider = new ModelProvider(fakeConfig, async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return response([endCall()]);
    });
    const state = createGame();
    state.rulesRevision = '4.1';
    state.factions.aurora.unity = 10000;
    await provider.decide(state, 'aurora', new AbortController().signal);
    const revisedInput = JSON.parse(bodies[0].input[0].content);
    expect(revisedInput.decisionFacts.unity).toMatchObject({ value: 100, maximum: 100, atMaximum: true, cohesionProductionMultiplier: 1.5 });
    expect(bodies[0].instructions).toContain('"startingUnity":60');
    expect(bodies[0].instructions).not.toContain('"startingUnity":6000');
    expect(bodies[0].instructions).toContain('0.5*基础舰队战力');
    expect(bodies[0].instructions).not.toContain('5*人口+基础舰队战力');
    delete state.rulesRevision;
    await provider.decide(state, 'aurora', new AbortController().signal);
    expect(bodies[1].instructions).toContain('5*人口+基础舰队战力');
    expect(bodies[1].instructions).not.toContain('0.5*基础舰队战力');
  });
  it('批量错误整批回滚，重新提交完整计划只扣一次资源', async () => {
    const bodies: Record<string, unknown>[] = [];
    const orders = [{ type: 'survey_system', args: { systemId: surveyTarget } }, { type: 'queue_ships', args: { planetId: 's0-p0', shipType: 'destroyer', count: 20 } }, { type: 'build_structure', args: { planetId: 's0-p0', structureType: 'mine' } }];
    const provider = new ModelProvider(fakeConfig, async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return response([batchCall(bodies.length === 1 ? orders : [orders[0], orders[2]], 'batch-' + bodies.length, '发展矿业并探索边境。')]);
    });
    const state = createGame();
    const before = stateHash(state);
    const decision = await provider.decide(state, 'aurora', new AbortController().signal);
    expect(stateHash(state)).toBe(before);
    expect(decision.metrics.requests).toBe(2);
    expect(decision.actions).toHaveLength(2);
    expect(decision.trace.slice(0, 3).map(trace => trace.disposition)).toEqual(['rolled_back', 'rejected', 'rolled_back']);
    expect(JSON.stringify(bodies[1].input)).toContain('整批退回');
    expect(decision.summary).toBe('发展矿业并探索边境。');
    expect(bodies[0].stream).toBe(true);
  });
  it('正确归一化根地址和已有v1地址，避免重复斜杠', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'war-provider-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    for (const base of ['https://provider.invalid', 'https://provider.invalid/', 'https://provider.invalid/v1/']) {
      const file = join(directory, 'AIKEY.env');
      await writeFile(file, `base=${base}\nkey=test-key`);
      expect((await readProviderConfig(file)).base).toBe('https://provider.invalid/v1');
    }
  });
  it('保留完整输出项，按call_id回传工具结果，统计usage且不向模型暴露密钥', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new ModelProvider(fakeConfig, async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1
        ? response([{ type: 'reasoning', id: 'opaque-reasoning', summary: [] }, { type: 'function_call', name: 'get_report', call_id: 'survey', arguments: JSON.stringify({ systemId: surveyTarget }) }])
        : response([endCall()]);
    });
    const decision = await provider.decide(createGame(), 'aurora', new AbortController().signal);
    expect(decision.actions).toHaveLength(0);
    expect(decision.summary).toBe('保留资源，准备扩张。');
    expect(decision.metrics.totalTokens).toBe(60);
    expect(JSON.stringify(bodies)).not.toContain(fakeConfig.key);
    expect(JSON.stringify(bodies[1].input)).toContain('opaque-reasoning');
    expect(JSON.stringify(bodies[1].input)).toContain('function_call_output');
    expect(JSON.stringify(bodies[1].input)).toContain('survey');
    expect(bodies[0].store).toBe(false);
  });

  it('重复call_id返回原错误，不重复执行；预算耗尽不提交', async () => {
    let calls = 0;
    const provider = new ModelProvider(fakeConfig, async () => {
      calls++;
      return response([batchCall([{ type: 'queue_ships', args: { planetId: 's0-p0', shipType: 'destroyer', count: calls === 1 ? 1000 : 1 } }], 'same')]);
    });
    await expect(provider.decide(createGame(), 'aurora', new AbortController().signal)).rejects.toThrow('决策预算耗尽');
    expect(calls).toBe(3);
  });

  it('错误信息脱敏，客户端错误不重试', async () => {
    let count = 0;
    const provider = new ModelProvider(fakeConfig, async () => { count++; return new Response(JSON.stringify({ error: { message: `rejected ${fakeConfig.key}` } }), { status: 401 }); });
    await expect(provider.decide(createGame(), 'aurora', new AbortController().signal)).rejects.toThrow('[密钥已隐藏]');
    expect(count).toBe(1);
  });
});

describe('比赛事务、存档与复盘', () => {
  it('一方三次批量纠错失败时，其他方有效计划也不提交', async () => {
    const provider = new ModelProvider(fakeConfig, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const actor = JSON.parse(body.input[0].content).factionId;
      return response([actor === 'aurora' ? batchCall([{ type: 'queue_ships', args: { planetId: 's0-p0', shipType: 'destroyer', count: 1000 } }], 'bad-' + body.input.length) : endCall()]);
    });
    const runner = await fixture('model', provider);
    const before = stateHash(runner.state);
    runner.start(true); await runner.waitIdle();
    expect(runner.status.phase).toBe('error');
    expect(runner.status.error).toContain('决策预算耗尽');
    expect(stateHash(runner.state)).toBe(before);
    expect(runner.lastDecisions).toBeNull();
  });
  it('一方接口失败时暂停，公共世界保持原样，重试后可以完成', async () => {
    let fail = true;
    const provider = new ModelProvider(fakeConfig, async () => fail ? new Response('{"error":{"message":"unavailable"}}', { status: 400 }) : response([endCall()]));
    const runner = await fixture('model', provider);
    const before = stateHash(runner.state);
    runner.start(true); await runner.waitIdle();
    expect(runner.status.phase).toBe('error');
    expect(stateHash(runner.state)).toBe(before);
    fail = false;
    runner.start(); await runner.waitIdle();
    expect(runner.state.round).toBe(2);
    expect(runner.state.result).not.toBeNull();
  });

  it('用户在模型请求中暂停，不提交半轮命令', async () => {
    const provider = new ModelProvider(fakeConfig, async (_url, init) => {
      await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return response([]);
    });
    const runner = await fixture('model', provider);
    const before = stateHash(runner.state);
    runner.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    runner.pause(); await runner.waitIdle();
    expect(runner.status.phase).toBe('paused');
    expect(runner.status.error).toBeNull();
    expect(stateHash(runner.state)).toBe(before);
  });

  it('保存恢复哈希一致，命令重放能重建每轮状态，历史恢复创建新分支', async () => {
    const runner = await fixture();
    const initial = structuredClone(runner.state);
    runner.start(); await runner.waitIdle();
    const loaded = await runner.store.load(runner.state.id);
    expect(loaded.hash).toBe(stateHash(runner.state));
    let replay: GameState = initial;
    for (let round = 1; round <= 2; round++) {
      const record = await runner.store.record(initial.id, round);
      replay = await advanceRound(replay, runner.pool, Object.fromEntries(Object.entries(record.decisions).map(([id, decision]) => [id, decision.actions])));
      for (const factionId of Object.keys(record.decisions)) replay.factions[factionId].strategies = [...replay.factions[factionId].strategies, { round, text: record.decisions[factionId].summary }].slice(-5);
      expect(stateHash(replay)).toBe(record.hash);
    }
    await runner.load(initial.id, 1);
    expect(runner.state.id).not.toBe(initial.id);
    expect(runner.state.round).toBe(1);
    expect((await runner.store.load(initial.id)).state.round).toBe(2);
  });

  it('拒绝存档路径穿越', async () => {
    const runner = await fixture();
    await expect(runner.store.load('../AIKEY.env')).rejects.toThrow('存档ID无效');
  });

  it('校验存档哈希，拒绝损坏的检查点', async () => {
    const runner = await fixture();
    const file = join(runner.store.root, runner.state.id, 'checkpoint.json');
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.state.day = 999;
    await writeFile(file, JSON.stringify(value));
    await expect(runner.store.load(runner.state.id)).rejects.toThrow('存档状态哈希不一致');
  });

  it('REST可创建、单步、存档和读取历史，接口不返回密钥', async () => {
    const runner = await fixture();
    const provider = new ModelProvider(fakeConfig, async () => new Response('{"data":[{"id":"grok-4.7"}]}', { status: 200 }));
    const { server, sockets } = createApplication(runner, async () => provider, join(tmpdir(), 'no-client-build'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { sockets.close(); server.close(() => resolve()); }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未启动');
    const base = `http://127.0.0.1:${address.port}`;
    const config = await (await fetch(`${base}/api/provider`)).json();
    expect(config.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain(fakeConfig.key);
    expect((await fetch(`${base}/api/start`, { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } })).status).toBe(403);
    await fetch(`${base}/api/step`, { method: 'POST' }); await runner.waitIdle();
    expect(runner.state.round).toBe(1);
    const saved = await (await fetch(`${base}/api/save`, { method: 'POST' })).json();
    expect(saved.round).toBe(1);
    const history = await (await fetch(`${base}/api/matches/${runner.state.id}/rounds/0`)).json();
    expect(history.state.round).toBe(0);
    const file = await readFile(join(runner.store.root, runner.state.id, 'checkpoint.json'), 'utf8');
    expect(file).not.toContain(fakeConfig.key);
  });
});
