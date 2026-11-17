import type { Action, GameState, Decision } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import { SRAS_CERBERUS, isCerberusMemory } from '../shared/sras13.js';
import { scriptKnowledge } from './adaptive-knowledge.js';
import { controller } from '../shared/v4.js';
import { failureCategory, failureDependency } from './sras11-rules.js';
import { realizedAssets } from './sras13-coordination.js';

type OrderEvent = { factionId?: string; accepted?: boolean; action?: Action; reason?: string; result?: { projectId?: string; projectIds?: string[] } };

export function reconcileSrasCerberus(state: GameState, actor: string, scriptMemory: ScriptMemory, decision: Decision) {
  const memory = scriptMemory.cerberus;
  if (!isCerberusMemory(memory)) return;
  const events = state.events.filter(event => event.round === state.round && event.type === 'order' && event.audience.includes(actor)).map(event => event.details as OrderEvent);
  const accepted = events.filter(event => event.factionId === actor && event.accepted === true && event.action);
  const failed = events.filter(event => event.factionId === actor && event.accepted === false && event.action);
  const selected = decision.scriptReport?.selected ?? [];
  const known = scriptKnowledge(state, actor);
  memory.receipts = (memory.receipts ?? []).filter(receipt => receipt.status === 'executed' || receipt.round >= state.round - 2);
  for (const event of [...accepted, ...failed]) {
    const group = selected.find(item => item.actions.some(action => JSON.stringify(action) === JSON.stringify(event.action)));
    if (!group || !event.action) continue;
    const projectIds = event.result?.projectIds ?? (event.result?.projectId ? [event.result.projectId] : []);
    const id = `${state.round}:${group.id}:${JSON.stringify(event.action)}`;
    if (!memory.receipts.some(receipt => receipt.id === id)) memory.receipts.push({ id, groupId: group.id, action: structuredClone(event.action), status: event.accepted ? 'executed' : 'failed', projectIds, round: state.round, evidence: event.reason ?? 'actual world order receipt' });
  }
  for (const receipt of memory.receipts.filter(receipt => receipt.status === 'executed')) {
    const action = receipt.action;
    if (receipt.projectIds.length) {
      const pending = receipt.projectIds.some(id => known.systems.some(system => system.projects.some(project => project.id === id)));
      const delivered = receipt.projectIds.every(id => action.type === 'queue_ships'
        ? known.fleets.some(fleet => fleet.ownerId === actor && fleet.ships.some(ship => ship.id === id + '-ship'))
        : action.type === 'build_structure' && known.systems.some(system => system.planets.some(planet => planet.ownerId === actor && planet.structures.some(structure => structure.id === id + '-structure'))));
      const colony = action.type === 'colonize_planet' && known.systems.some(system => system.planets.some(planet => planet.id === action.args.planetId && planet.ownerId === actor));
      const base = action.type === 'build_starbase' && known.systems.some(system => system.id === action.args.systemId && system.ownerId === actor && system.base);
      const survey = action.type === 'survey_system' && known.factions[actor].surveyed.includes(String(action.args.systemId));
      if (delivered || colony || base || survey) { receipt.status = 'completed'; receipt.evidence = 'actual delivered asset or target ownership'; }
      else if (!pending) { receipt.evidence = 'paid project absent without verifiable retained outcome; completion not inferred'; }
    } else if (action.type === 'move_fleet') {
      const fleet = known.fleets.find(fleet => fleet.id === action.args.fleetId && fleet.ownerId === actor);
      if (fleet && fleet.systemId === action.args.systemId && !fleet.order && !fleet.transit) { receipt.status = 'completed'; receipt.evidence = 'assigned fleet actually arrived'; }
      else if (!fleet) { receipt.status = 'failed'; receipt.evidence = 'assigned fleet no longer exists'; }
    } else if (['set_jobs', 'set_structure_status', 'set_welfare', 'choose_policy', 'merge_fleets', 'cancel_order'].includes(action.type)) { receipt.status = 'completed'; receipt.evidence = 'world executed immediate configuration change'; }
  }
  memory.tasks = memory.base.tasks;
  for (const task of memory.tasks) {
    if (task.id.startsWith('group:')) {
      const receipts = memory.receipts.filter(receipt => receipt.groupId === task.plannedGroup && receipt.round >= task.lastProgressRound);
      if (receipts.length && receipts.every(receipt => receipt.status === 'completed')) { task.status = 'completed'; task.stage = 'exit'; task.evidence = receipts.map(receipt => receipt.evidence).join('; '); }
      else if (receipts.some(receipt => receipt.status === 'failed')) { task.stage = 'exit'; task.assets = []; task.reserve = {}; task.blockers = receipts.filter(receipt => receipt.status === 'failed').map(receipt => receipt.evidence); }
    }
    for (const event of accepted) if (event.action?.type === 'merge_fleets') {
      const ids = event.action.args.fleetIds as string[];
      if (task.assets.some(id => ids.includes(id))) { task.assets = [...new Set([...task.assets.filter(id => !ids.includes(id)), ids[0]])]; task.lastProgressRound = state.round; delete task.diagnosedRound; }
    }
    task.assets = task.assets.filter(id => known.fleets.some(fleet => fleet.ownerId === actor && fleet.id === id));
    const war = known.wars?.find(item => item.endedDay === undefined && item.factions.includes(actor) && item.factions.includes(task.opponent ?? ''));
    if (war && task.expert === 'campaign') {
      task.warId = war.id; task.warType = war.type;
      const goal = war.goals[actor]?.find(item => item.systemId === task.target && !item.invalid) ?? war.goals[actor]?.find(item => !item.invalid);
      if (goal) task.target = goal.systemId;
    } else if (task.warId) {
      const ended = known.wars?.find(item => item.id === task.warId && item.endedDay !== undefined);
      task.stage = 'exit'; task.assets = []; task.reserve = {};
      task.status = ended && known.systems.some(system => system.id === task.target && system.ownerId === actor && controller(system) === actor) ? 'completed' : 'planned';
      task.exit = 'world confirmed war ended; outcome recorded separately';
    }
    const row = selected.find(item => item.id === task.plannedGroup);
    if (!row) continue;
    const completed = row.actions.every(action => accepted.some(event => JSON.stringify(event.action) === JSON.stringify(action)));
    if (completed && task.status !== 'completed' && task.stage !== 'exit') { task.status = 'executed'; task.blockers = []; }
    else if (row.actions.some(action => failed.some(event => JSON.stringify(event.action) === JSON.stringify(action)))) { task.status = 'planned'; task.assets = []; task.reserve = {}; task.blockers = ['world rejected one or more planned actions']; }
  }
  for (const event of failed) {
    const row = selected.find(item => item.actions.some(action => JSON.stringify(action) === JSON.stringify(event.action)));
    if (!row) continue;
    const reason = event.reason ?? 'world rejected action', category = failureCategory(reason);
    memory.base.failures.push({ id: row.id, actions: row.actions, reason, category, dependency: failureDependency(known, actor, row.actions, category) });
  }
  memory.base.failures = memory.base.failures.slice(-64);
  for (const task of memory.tasks) if (task.stage === 'exit' || task.status === 'planned') { task.assets = []; task.reserve = {}; }
  memory.reserved.fleets = [...new Set(memory.tasks.flatMap(task => task.assets))];
  memory.reserved.resources = Object.fromEntries(memory.tasks.flatMap(task => Object.entries(task.reserve)).reduce((totals, [resource, amount]) => totals.set(resource, (totals.get(resource) ?? 0) + amount), new Map<string, number>()));
  if (memory.baseline) {
    const actual = realizedAssets(known, actor);
    memory.realized = { population: actual.population - memory.baseline.population, structures: actual.structures - memory.baseline.structures, ships: actual.ships - memory.baseline.ships, territories: actual.territories - memory.baseline.territories };
  }
  memory.quality.executed = accepted.length;
  memory.quality.completed = memory.tasks.filter(task => task.status === 'completed').length;
  memory.quality.accepted = selected.reduce((sum, group) => sum + group.actions.length, 0);
  memory.quality.submitted = decision.actions.length;
  const report = decision.scriptReport?.cerberus;
  if (report) {
    report.realized = memory.realized;
    report.receipts = structuredClone(memory.receipts);
    report.tasks = structuredClone(memory.tasks);
    report.execution = { accepted: accepted.length, failed: failed.length, completedTasks: memory.tasks.filter(task => task.status === 'completed').map(task => task.id) };
    report.quality.executed = memory.quality.executed;
    report.quality.completed = memory.quality.completed;
    report.quality.accepted = memory.quality.accepted;
    report.quality.submitted = memory.quality.submitted;
    report.quality.executedRate = memory.quality.submitted ? memory.quality.executed / memory.quality.submitted : 1;
  }
  if (decision.scriptReport?.sras && report) decision.scriptReport.sras.execution = report.execution;
  memory.revision = SRAS_CERBERUS.revision;
}
