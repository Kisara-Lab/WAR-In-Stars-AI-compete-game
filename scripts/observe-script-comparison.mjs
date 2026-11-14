import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const load = file => import(pathToFileURL(resolve(manifest.build, file)).href);
const [{ scoreBreakdown }, { governanceView }, { rates, LABOR }] = await Promise.all([
  load('shared/scoring.js'), load('shared/governance.js'), load('shared/industry.js'),
]);
const output = join(directory, 'observation');
await mkdir(output, { recursive: true });
const rows = [];
const api = async (path, method = 'GET') => {
  const response = await fetch('http://127.0.0.1:8787/api/' + path, { method, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Local API ' + response.status + ': ' + await response.text());
  return response.json();
};
function summarize(saved) {
  const state = saved.state;
  return { round: state.round, day: state.day, hash: saved.hash, result: state.result,
    wars: state.wars, factions: state.config.factionIds.map(actor => {
      const faction = state.factions[actor], decision = saved.decisions?.[actor];
      const planets = state.systems.flatMap(system => system.planets).filter(p => p.ownerId === actor);
      const report = decision?.scriptReport;
      return { actor, name: faction.name, strategy: state.config.scriptStrategies[actor],
        score: scoreBreakdown(state, actor), governance: governanceView(state, actor),
        systems: state.systems.filter(s => s.ownerId === actor).length, colonies: planets.length,
        population: planets.reduce((sum, p) => sum + p.population, 0),
        idle: planets.reduce((sum, p) => sum + Math.max(0, p.population - p.structures.reduce((jobs, s) => jobs + LABOR[s.type].jobs * (rates(p, state.day)[s.id] ?? 0), 0)), 0),
        resources: Object.fromEntries(Object.entries(faction.resources).map(([key, value]) => [key, value / 1000])),
        unity: faction.unity / 100, shortages: faction.shortages,
        welfare: faction.welfare?.choice, paid: faction.welfare?.last?.fraction,
        route: faction.civilization?.choice, duty: faction.responsibility,
        ships: state.fleets.filter(f => f.ownerId === actor).reduce((sum, f) => sum + f.ships.length, 0),
        projects: state.systems.flatMap(s => s.projects.map(p => ({ ...p, systemId: s.id }))).filter(p => p.ownerId === actor),
        structures: planets.flatMap(p => p.structures.map(s => ({ planet: p.id, type: s.type, sealed: !!s.sealed, operation: rates(p, state.day)[s.id] ?? 0 }))),
        actions: decision?.actions ?? [], stop: report?.turn?.stop, turn: report?.turn,
        selected: report?.v412?.selectedGroups ?? report?.v41?.selectedGroups,
        removed: report?.v412?.removed ?? report?.v41?.removed,
        development: report?.v412?.development, operation: faction.scriptMemory?.operation,
        budget: { candidates: report?.candidates, forecasts: report?.forecasts, evaluations: report?.search?.evaluations, validations: report?.validations },
        ms: decision?.metrics.durationMs, metrics: saved.metrics[actor],
        failures: state.events.filter(e => e.round === state.round && e.type === 'order' && e.details?.factionId === actor && e.details?.accepted === false),
        events: state.events.filter(e => e.round === state.round && e.audience.includes(actor) && ['colony', 'construction', 'capture', 'war', 'battle', 'religion'].includes(e.type)),
      };
    }) };
}
let lastPulse = 0;
for (;;) {
  const live = await api('state');
  if (live.state.id !== manifest.id) throw new Error('Observed match changed');
  if (live.state.round > manifest.stopRound) throw new Error('Observation round limit exceeded');
  for (let round = (rows.at(-1)?.round ?? 0) + 1; round <= live.state.round; round++) {
    const parent=manifest.parent&&round<=manifest.parent.round?manifest.parent:null;
    const saved = JSON.parse(await readFile(join(parent?resolve(parent.directory):directory, 'matches', parent?.id??manifest.id, `round-${String(round).padStart(4, '0')}.json`), 'utf8'));
    const row = summarize(saved);
    row.revision=parent?parent.revision:manifest.v412Revision;
    row.matchId=saved.state.id;
    for (const f of row.factions) {
      if (f.metrics.requests || f.metrics.totalTokens) throw new Error('Unexpected model usage: ' + f.actor);
      if (f.turn && f.turn.actions !== f.actions.length) throw new Error('Action/report mismatch: ' + f.actor);
    }
    rows.push(row);
    await writeFile(join(output, 'rounds.json'), JSON.stringify(rows));
    console.log(JSON.stringify({ round, factions: row.factions.map(f => ({ id: f.actor, strategy: f.strategy, systems: f.systems, colonies: f.colonies, population: f.population, score: f.score.total, ships: f.ships, actions: f.actions.length, q: f.governance.quality, stop: f.stop })) }));
    if (round % 10 === 0) await writeFile(join(output, `checkpoint-${round}.json`), JSON.stringify(row, null, 2));
  }
  await writeFile(join(output, 'runtime.json'), JSON.stringify({ round: live.state.round, phase: live.status.phase, planning: live.status.planning, error: live.status.error }));
  if (Date.now() - lastPulse >= 30000) {
    console.log(JSON.stringify({ pulse: true, round: live.state.round, phase: live.status.phase, error: live.status.error }));
    lastPulse = Date.now();
  }
  if (!live.status.running && !live.status.busy) {
    await api('save', 'POST');
    await writeFile(join(output, 'stopped.json'), JSON.stringify(live));
    console.log(JSON.stringify({ stopped: true, round: live.state.round, error: live.status.error, expected: live.state.round === manifest.stopRound }));
    break;
  }
  await setTimeout(5000);
}
