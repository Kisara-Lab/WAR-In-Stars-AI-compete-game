import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG, SHIPS } from '../src/shared/rules.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool, defaultWorkers } from '../src/sim/pool.js';
import { createGame } from '../src/sim/world.js';

const config = { ...structuredClone(DEFAULT_CONFIG), systemCount: 128, controller: 'scripted' as const };
const fixture = createGame(config, 'benchmark');
for (const [index, system] of fixture.systems.entries()) {
  const ownerId = config.factionIds[Math.floor(index / (fixture.systems.length / config.factionIds.length))];
  for (let fleetIndex = 0; fleetIndex < 16; fleetIndex++) fixture.fleets.push({ id: `${system.id}-bench-${fleetIndex}`, name: '基准舰队', ownerId, systemId: system.id, position: { x: 100 + fleetIndex * 40, y: 100 }, transit: null, order: { systemId: system.id, position: { x: 900 - fleetIndex * 20, y: 900 }, route: [], targetFleetId: null }, ships: Array.from({ length: 8 }, (_, shipIndex) => ({ id: `${system.id}-${fleetIndex}-${shipIndex}`, type: 'destroyer', hull: SHIPS.destroyer.power })) });
}
const results = [];
for (const workerCount of [0, 1, defaultWorkers()]) {
  const pool = new SimulationPool(workerCount);
  try {
    await advanceRound(createGame({ ...structuredClone(DEFAULT_CONFIG), maxRounds: 1 }, 'warmup'), pool);
    const started = performance.now();
    const state = await advanceRound(structuredClone(fixture), pool);
    const result = { workers: workerCount, elapsedMs: Math.round(performance.now() - started), hash: stateHash(state), metrics: pool.metrics };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally { await pool.close(); }
}
if (new Set(results.map(result => result.hash)).size !== 1) throw new Error('线程数改变了模拟结果');
await mkdir('.data/verification', { recursive: true });
await writeFile('.data/verification/benchmark.json', JSON.stringify({ systems: fixture.systems.length, ships: fixture.fleets.reduce((sum, fleet) => sum + fleet.ships.length, 0), results }, null, 2));
