import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG, FACTION_PRESETS, factionRecord } from '../src/shared/rules.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame } from '../src/sim/world.js';

const argument = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const pool = new SimulationPool(Number(argument('--workers', '4')));
const started = performance.now();
try {
  const count = Number(argument('--factions', '4'));
  const ids = FACTION_PRESETS.slice(0, count).map(faction => faction.id);
  const initial = createGame({ ...structuredClone(DEFAULT_CONFIG), factionIds: ids, models: factionRecord(ids, () => 'grok-4.7'), systemCount: Number(argument('--systems', String(count * 6))), controller: 'scripted', maxRounds: Number(argument('--rounds', '120')), seed: argument('--seed', DEFAULT_CONFIG.seed) });
  const runner = new MatchRunner(initial, pool, new MatchStore(), async () => { throw new Error('脚本局不使用模型'); });
  await runner.initialize();
  let state = runner.state;
  while (!state.result) {
    runner.start(true); await runner.waitIdle();
    if (runner.status.error) throw new Error(runner.status.error);
    state = runner.state;
    if (state.round % 10 === 0 || state.result) console.log(JSON.stringify({ round: state.round, day: state.day, fleets: state.fleets.length, colonies: state.systems.flatMap(system => system.planets).filter(planet => planet.ownerId).length, result: state.result }));
  }
  await mkdir('.data/verification', { recursive: true });
  await writeFile(`.data/verification/scripted-${count}-final.json`, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ matchId: state.id, hash: stateHash(state), elapsedMs: Math.round(performance.now() - started), workers: pool.metrics }, null, 2));
} finally { await pool.close(); }
