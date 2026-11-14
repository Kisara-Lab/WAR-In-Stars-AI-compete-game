import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import type { MatchConfig } from '../src/shared/types.js';
import { configureSeats, controllerLabel, validateControllers } from '../src/shared/controllers.js';
import { createGame } from '../src/sim/world.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';

const config = (): MatchConfig => ({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted', maxRounds: 120,
  scriptStrategy: 'adaptive-v4.12', scriptSearchProfile: 'standard',
  scriptStrategies: { aurora: 'adaptive-v4.1', umbra: 'adaptive-v4.12', verdant: 'adaptive-v4.1', cobalt: 'adaptive-v4.12' } });

it('requires a complete pure-script comparison roster and includes it in the hash', () => {
  const selected = config();
  expect(() => validateControllers(selected)).not.toThrow();
  expect(controllerLabel(selected, 'aurora')).toBe('智能脚本 · adaptive-v4.1');
  expect(controllerLabel(selected, 'umbra')).toBe('智能脚本 · adaptive-v4.12');
  for (const change of [
    (value: MatchConfig) => { delete value.scriptStrategies!.aurora; },
    (value: MatchConfig) => { value.scriptStrategies!.extra = 'adaptive-v4.1'; },
    (value: MatchConfig) => { value.controller = 'model'; },
    (value: MatchConfig) => { value.scriptStrategy = 'legacy'; },
  ]) { const invalid = config(); change(invalid); expect(() => validateControllers(invalid)).toThrow(); }
  expect(configureSeats(selected).scriptStrategies).toBeUndefined();
  const state = createGame(selected, 'comparison');
  const before = stateHash(state);
  state.config.scriptStrategies!.aurora = 'adaptive-v4.12';
  expect(stateHash(state)).not.toBe(before);
});

it('dispatches both real strategies, persists their memories, and stops after a committed boundary', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'stars-comparison-'));
  let calls = 0;
  const runner = new MatchRunner(createGame(config()), new SimulationPool(0),
    new MatchStore(join(folder, 'matches'), join(folder, 'session.json')),
    async () => { calls++; throw new Error('No paid calls permitted'); });
  try {
    await runner.create(config(), 0, { computeWorkers: 2, planningCacheMiB: 64 });
    let stopping = false;
    runner.subscribe(() => {
      if (runner.state.round >= 1 && runner.status.running && !stopping) {
        stopping = true; runner.pause(); stopping = false;
      }
    });
    runner.start(); await runner.waitIdle();
    expect(runner.status.error).toBeNull();
    expect(runner.status.running).toBe(false);
    expect(runner.state.round).toBe(1);
    expect(runner.state.config.maxRounds).toBe(120);
    expect(calls).toBe(0);
    for (const [actor, version] of Object.entries(config().scriptStrategies!)) {
      expect(runner.lastDecisions![actor].scriptReport?.version).toBe(version);
      expect(runner.state.factions[actor].scriptMemory?.version).toBe(version);
      expect(runner.status.metrics[actor].requests).toBe(0);
    }
    const saved = await runner.store.load(runner.state.id);
    await runner.recover(saved);
    expect(runner.state.config.scriptStrategies).toEqual(config().scriptStrategies);
    expect(stateHash(runner.state)).toBe(saved.hash);
    const chronicle = await runner.store.exportChronicle(runner.state.id);
    expect(chronicle).toContain('智能脚本 · adaptive-v4.1');
    expect(chronicle).toContain('智能脚本 · adaptive-v4.12');
  } finally { await runner.close(); await rm(folder, { recursive: true, force: true }); }
}, 60000);
