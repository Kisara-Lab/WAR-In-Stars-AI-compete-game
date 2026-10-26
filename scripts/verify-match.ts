import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { MatchStore } from '../src/server/storage.js';
import { readProviderConfig } from '../src/server/provider.js';
import { SimulationPool } from '../src/sim/pool.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';

const option = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const id = option('--id', '');
if (!id) throw new Error('请提供 --id 比赛ID');
const store = new MatchStore(option('--root', '.data/matches'));
const loaded = await store.load(id);
const logs = await store.auditRecords(id);
const initial = JSON.parse(await readFile(`${store.root}/${id}/initial.json`, 'utf8'));
if (initial.hash !== stateHash(initial.state)) throw new Error('初始状态哈希不一致');
let replay = initial.state;
let verifiedRounds = 0;
const pool = new SimulationPool(Number(option('--workers', '0')));
try {
  if (process.argv.includes('--replay')) for (let round = replay.round + 1; round <= loaded.state.round; round++) {
    const record = await store.record(id, round);
    replay = await advanceRound(replay, pool, Object.fromEntries(Object.entries(record.decisions).map(([factionId, decision]) => [factionId, decision.actions])));
    for (const [factionId, decision] of Object.entries(record.decisions)) replay.factions[factionId].strategies = [...replay.factions[factionId].strategies, { round, text: decision.summary }].slice(-5);
    if (stateHash(replay) !== record.hash) {
      const differences: string[] = [];
      const compare = (actual: unknown, expected: unknown, path: string) => {
        if (differences.length >= 12 || JSON.stringify(actual) === JSON.stringify(expected)) return;
        if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
          for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) compare((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
        } else differences.push(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      };
      compare(replay, record.state, 'state');
      console.error(differences.join('\n'));
      throw new Error(`第${round}轮命令重放哈希不一致`);
    }
    verifiedRounds++;
  }
  let keyChecked = false;
  try {
    const config = await readProviderConfig();
    keyChecked = true;
    if (JSON.stringify(logs).includes(config.key) || JSON.stringify(loaded).includes(config.key)) throw new Error('日志存在密钥');
  } catch (error) { if (keyChecked) throw error; }
  const report = { id, round: loaded.state.round, stateHash: loaded.hash, auditRecords: logs.length, finalAuditHash: logs.at(-1)?.hash, replayVerifiedRounds: verifiedRounds, keyChecked, requests: logs.filter(record => record.category === 'model.request').length, modelFailures: logs.filter(record => record.category === 'model.failure').length, policies: logs.filter(record => record.category === 'event.policy').length, economySteps: logs.filter(record => record.category === 'economy.step').length, movementSteps: logs.filter(record => record.category === 'movement.step').length, battles: logs.filter(record => record.category === 'event.battle').length };
  await mkdir('.data/verification', { recursive: true });
  await writeFile(`.data/verification/audit-${id}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await pool.close(); }
