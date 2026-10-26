import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame } from '../src/sim/world.js';
import { ModelProvider, readProviderConfig } from '../src/server/provider.js';
import { MatchRunner } from '../src/server/runner.js';
import { MatchStore } from '../src/server/storage.js';

const roundsIndex = process.argv.indexOf('--rounds');
const rounds = roundsIndex >= 0 ? Number(process.argv[roundsIndex + 1]) : 2;
const provider = new ModelProvider(await readProviderConfig());
const pool = new SimulationPool(2);
const runner = new MatchRunner(createGame({ ...structuredClone(DEFAULT_CONFIG), maxRounds: rounds }), pool, new MatchStore(), async () => provider);
let progress = '';
runner.subscribe(() => {
  const current = JSON.stringify({ round: runner.state.round, phase: runner.status.phase, ai: runner.status.ai });
  if (current !== progress) { console.log(current); progress = current; }
});
try {
  await runner.initialize();
  runner.start();
  await runner.waitIdle();
  await mkdir('.data/verification', { recursive: true });
  const report = { success: !!runner.state.result && !runner.status.error, error: runner.status.error, matchId: runner.state.id, rounds: runner.state.round, result: runner.state.result, metrics: runner.status.metrics, lastDecisions: runner.lastDecisions };
  await writeFile('.data/verification/ai-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ matchId: report.matchId, rounds: report.rounds, result: report.result, metrics: report.metrics }, null, 2));
  if (runner.status.error) throw new Error(runner.status.error);
  if (!runner.state.result) throw new Error('真实模型短局未结束');
} finally { await runner.close(); }
