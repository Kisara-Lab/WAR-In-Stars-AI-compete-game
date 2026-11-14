import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, FACTION_PRESETS } from '../src/shared/rules.js';
import { configureSeats, factionController, validateControllers } from '../src/shared/controllers.js';
import type { Decision, GameState, MatchConfig } from '../src/shared/types.js';
import { createGame } from '../src/sim/world.js';
import { stateHash } from '../src/sim/math.js';
import { emptyMetrics } from '../src/sim/bot.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { SimulationPool } from '../src/sim/pool.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';
import { ModelProvider } from '../src/server/provider.js';
import { createApplication } from '../src/server/app.js';
import { response, endCall } from './helpers/responses.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const config = (): MatchConfig => configureSeats({ ...structuredClone(DEFAULT_CONFIG), controller: 'mixed', maxRounds: 1, scriptStrategy: 'adaptive-v3', scriptSearchProfile: 'standard' });
const waitDecision = (): Decision => ({ actions: [], summary: '等待', trace: [], metrics: emptyMetrics() });
const fakeProvider = () => new ModelProvider({ base: 'https://mixed.invalid/v1', key: 'test-only' }, async () => response([endCall()]));
async function fixture(provider = fakeProvider(), script?: ConstructorParameters<typeof MatchRunner>[4], workers = 0) {
  const folder = await mkdtemp(join(tmpdir(), 'stars-mixed-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const runner = new MatchRunner(createGame(config(), 'mixed-test'), new SimulationPool(workers), new MatchStore(join(folder, 'matches'), join(folder, 'session.json')), async () => provider, script);
  cleanup.push(() => runner.close());
  await runner.create(config(), workers, { computeWorkers: workers, planningCacheMiB: 0 });
  return runner;
}

it('validates 4–8 seats, rejects missing/extra/all-one-kind seats and wrong model maps', () => {
  for (let count = 4; count <= 8; count++) {
    const selected = configureSeats({ ...config(), factionIds: FACTION_PRESETS.slice(0, count).map(faction => faction.id) });
    expect(() => validateControllers(selected)).not.toThrow();
    expect(Object.keys(selected.models)).toEqual(selected.factionIds.filter(id => factionController(selected, id) === 'model'));
  }
  for (const change of [
    (value: MatchConfig) => { delete value.factionControllers!.aurora; },
    (value: MatchConfig) => { value.factionControllers!.unknown = 'model'; },
    (value: MatchConfig) => { for (const id of value.factionIds) value.factionControllers![id] = 'model'; },
    (value: MatchConfig) => { value.models.umbra = 'unneeded'; },
    (value: MatchConfig) => { delete value.models.aurora; },
    (value: MatchConfig) => { value.scriptStrategy = 'adaptive-v2'; },
  ]) {
    const selected = config(); change(selected);
    expect(() => validateControllers(selected)).toThrow();
  }
  const legacy = { ...structuredClone(DEFAULT_CONFIG), controller: 'scripted' as const };
  const before = JSON.stringify(legacy);
  expect(factionController(legacy, 'aurora')).toBe('scripted');
  validateControllers(legacy);
  expect(JSON.stringify(legacy)).toBe(before);
  const changed = configureSeats({ ...config(), factionControllers: { ...config().factionControllers, aurora: 'scripted' } });
  expect(changed.models.aurora).toBeUndefined();
});

it('dispatches model seats only, uses the same boundary, and restores the saved roster', async () => {
  const provider = fakeProvider();
  const decide = vi.spyOn(provider, 'decide');
  const boundaries: string[] = [];
  const script = vi.fn(async (state: GameState) => {
    boundaries.push(stateHash(state)); return waitDecision();
  });
  const runner = await fixture(provider, script);
  const before = stateHash(runner.state);
  expect(runner.status.running).toBe(false);
  expect(decide).not.toHaveBeenCalled();
  runner.start(true); await runner.waitIdle();
  expect(runner.status.error).toBeNull();
  expect(runner.state.round).toBe(1);
  expect(decide.mock.calls.map(call => call[1]).sort()).toEqual(['aurora', 'verdant']);
  expect(script.mock.calls).toHaveLength(2);
  expect(boundaries).toEqual([before, before]);
  expect(runner.status.metrics.umbra.requests).toBe(0);
  expect(runner.status.metrics.aurora.requests).toBe(1);
  const saved = await runner.store.load(runner.state.id);
  await runner.recover(saved);
  expect(runner.state.config).toEqual(config());
  expect(stateHash(runner.state)).toBe(saved.hash);
  expect(await runner.store.exportChronicle(runner.state.id)).toContain('智能脚本 · adaptive-v3');
});

it('model failure cancels planning and preserves the whole boundary and incurred usage', async () => {
  const provider = fakeProvider();
  let release!: () => void;
  const scriptEntered = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(PlanningPool.prototype, 'decide').mockImplementation(async (_state, signal) => {
    release();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('planning cancelled')), { once: true }));
    return {};
  });
  vi.spyOn(provider, 'decide').mockImplementation(async (_state, actor, _signal, _progress, metrics) => {
    await scriptEntered;
    metrics?.({ ...emptyMetrics(), requests: 1, totalTokens: 12 });
    if (actor === 'aurora') throw new Error('model failed');
    return waitDecision();
  });
  const runner = await fixture(provider);
  const before = stateHash(runner.state);
  runner.start(true); await runner.waitIdle();
  expect(runner.status.error).toContain('model failed');
  expect(stateHash(runner.state)).toBe(before);
  expect(runner.lastDecisions).toBeNull();
  expect(runner.status.metrics.aurora.requests).toBe(1);
});

it('worker failure aborts model requests without partial submission', async () => {
  const provider = fakeProvider();
  let release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(provider, 'decide').mockImplementation(async (_state, _actor, signal) => {
    release();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('model cancelled')), { once: true }));
  });
  vi.spyOn(PlanningPool.prototype, 'decide').mockImplementation(async () => { await started; throw new Error('worker failed'); });
  const runner = await fixture(provider);
  const before = stateHash(runner.state);
  runner.start(true); await runner.waitIdle();
  expect(runner.status.error).toContain('worker failed');
  expect(stateHash(runner.state)).toBe(before);
});

it('pause discards late model decisions and skips eliminated seats', async () => {
  const provider = fakeProvider();
  let release!: () => void;
  const entered = new Promise<void>(resolve => { release = resolve; });
  const decide = vi.spyOn(provider, 'decide').mockImplementation(async (_state, _actor, signal) => {
    release();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return waitDecision();
  });
  const script = vi.fn(() => waitDecision());
  const runner = await fixture(provider, script);
  runner.state.factions.verdant.eliminatedDay = 0;
  const before = stateHash(runner.state);
  runner.start(true); await entered; runner.pause(); await runner.waitIdle();
  expect(decide.mock.calls.map(call => call[1])).toEqual(['aurora']);
  expect(stateHash(runner.state)).toBe(before);
  expect(runner.status.phase).toBe('paused');
  expect(runner.lastDecisions).toBeNull();
});

it('real V3 planning receives only script seats and matches serial/parallel world and memory', async () => {
  const states: ReturnType<typeof createGame>[] = [];
  for (const workers of [0, 2]) {
    const runner = await fixture(fakeProvider(), undefined, workers);
    runner.state.id = 'mixed-deterministic';
    await runner.initialize();
    runner.start(true); await runner.waitIdle();
    expect(runner.status.error).toBeNull();
    expect(runner.state.factions.aurora.scriptMemory).toBeUndefined();
    expect(runner.state.factions.umbra.scriptMemory?.version).toBe('adaptive-v3');
    const scripts = (await runner.store.auditRecords(runner.state.id)).filter(record => record.category === 'script.input').map(record => record.factionId).sort();
    expect(scripts).toEqual(['cobalt', 'umbra']);
    states.push(runner.state);
  }
  expect(stateHash(states[0])).toBe(stateHash(states[1]));
}, 60000);

it('REST creates paused mixed matches, rejects invalid seats without replacing the match', async () => {
  const provider = fakeProvider(), runner = await fixture(provider, () => waitDecision());
  const decide = vi.spyOn(provider, 'decide');
  const { server, sockets } = createApplication(runner, async () => provider, join(tmpdir(), 'no-client'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { sockets.close(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server');
  const post = (body: unknown) => fetch('http://127.0.0.1:' + address.port + '/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post({ ...config(), computeWorkers: 0 })).ok).toBe(true);
  const before = stateHash(runner.state);
  expect((await post({ ...config(), factionControllers: {} })).ok).toBe(false);
  expect(stateHash(runner.state)).toBe(before);
  expect(runner.status.running).toBe(false);
  expect(decide).not.toHaveBeenCalled();
});
