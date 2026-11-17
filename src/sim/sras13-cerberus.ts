import { performance } from 'node:perf_hooks';
import type { Action, Decision, GameState } from '../shared/types.js';
import type { ScriptMemory, ScriptReport } from '../shared/adaptive.js';
import { SRAS_CERBERUS, type CerberusMemory, type CerberusReport } from '../shared/sras13.js';
import { SRAS, srasStage, type SrasMemory } from '../shared/sras11.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { controller } from '../shared/v4.js';
import { emptyMetrics } from './bot.js';
import { StagingArea } from './actions.js';
import { validateScriptPlan } from './adaptive-adapter.js';
import { responsibilityRules, fallbackRules, funding } from './sras11-experts.js';
import { economicRules } from './sras11-economy.js';
import { militaryRules, refreshTasks } from './sras13-military.js';
import { conflictKeys, intentKeys, responseRules, threatTable, knownArrival, candidateDependency, fallbackChecks } from './sras11-response.js';
import { group, ledger, owned, ownPower, safeContactPath, deadlineSafe, basics, failureDependency, type RuleGroup } from './sras11-rules.js';
import { noChange, scheduledRisk } from './sras11.js';
import { governanceGroups, forceGroups, processingGroups, civilizationGroups, cerberusDependency } from './sras13-experts.js';
import type { PlanningHooks } from './adaptive-v2.js';
import { acceptedTask, fundingGoal, protectedFunding, realizedAssets } from './sras13-coordination.js';
import { arrival } from './sras11-rules.js';
import { fleetPower } from './math.js';

const makeExperts = () => ({
  'governance-recovery': { checked: 0, actions: 0, blockers: [] as string[] },
  'force-conversion': { checked: 0, actions: 0, blockers: [] as string[] },
  'occupation-garrison': { checked: 0, actions: 0, blockers: [] as string[] },
  'civilization-conversion': { checked: 0, actions: 0, blockers: [] as string[] },
});
const actionKey = (action: Action) => `${action.type}:${JSON.stringify(action.args)}`;

function memoryFor(previous: ScriptMemory | undefined): CerberusMemory {
  if (previous?.version === SRAS_CERBERUS.version && previous.cerberus) return structuredClone(previous.cerberus);
  const base = previous?.version === 'sras-v1.1' && previous.sras ? structuredClone(previous.sras) : { revision: SRAS.revision, stage: 'exploration', tasks: [], failures: [] } as SrasMemory;
  return { version: SRAS_CERBERUS.version, revision: SRAS_CERBERUS.revision, tasks: structuredClone(base.tasks), experts: makeExperts(), quality: { planned: 0, submitted: 0, accepted: 0, executed: 0, completed: 0, stateChanges: 0, military: 0, governance: 0 }, cooldowns: base.cooldowns ?? {}, reserved: { fleets: [], resources: {} }, base };
}

function occupationGroups(world: GameState, actor: string, rows: CerberusReport['occupation']): RuleGroup[] {
  const result: RuleGroup[] = [];
  const wars = world.wars?.filter(war => war.endedDay === undefined && war.factions.includes(actor)) ?? [];
  for (const war of wars.sort((a, b) => a.id.localeCompare(b.id))) {
    const targets = [...new Set([...(war.goals[actor] ?? []).filter(item => !item.invalid).map(item => item.systemId), ...world.systems.filter(system => system.occupationWarId === war.id || world.cessions?.some(cession => cession.warId === war.id && cession.to === actor && cession.systemId === system.id)).map(system => system.id)])];
    for (const goal of targets.sort().map(systemId => ({ systemId }))) {
      const target = world.systems.find(system => system.id === goal.systemId);
      if (!target || controller(target) !== actor) continue;
      const local = world.fleets.filter(fleet => fleet.ownerId === actor && fleet.systemId === target.id && !fleet.order && !fleet.transit && !fleet.withdrawal);
      const reservePower = local.reduce((sum, fleet) => sum + ownPower(world, actor, fleet), 0);
      const threatPower = world.fleets.filter(fleet => fleet.ownerId !== actor && war.factions.includes(fleet.ownerId) && knownArrival(world, fleet.ownerId, fleet, target.id) <= 300).reduce((sum, fleet) => sum + fleetPower(fleet), 0);
      const guardPower = Math.max(threatPower - (target.ownerId === actor ? target.base?.hull ?? 0 : 0), local.length ? Math.min(...local.map(fleet => ownPower(world, actor, fleet))) : 0);
      const actionNames: string[] = [];
      const near = local.filter(fleet => Math.hypot(fleet.position.x - local[0].position.x, fleet.position.y - local[0].position.y) <= 20);
      if (near.length > 1) {
        result.push(group('defense', 0, 125, [{ type: 'merge_fleets', args: { fleetIds: near.map(fleet => fleet.id).slice(0, 20) } }], `consolidate occupied garrison at ${target.id}`));
        actionNames.push('merge_fleets');
      }
      if (reservePower < guardPower) {
        const nearby = world.fleets.filter(fleet => fleet.ownerId === actor && fleet.systemId && !fleet.order && !fleet.transit && !fleet.withdrawal && !local.some(item => item.id === fleet.id)).sort((a, b) => a.id.localeCompare(b.id)).find(fleet => target.neighbors.includes(fleet.systemId!));
        if (nearby && reservePower + ownPower(world, actor, nearby) >= guardPower && arrival(world, actor, nearby, target.id) <= 300) {
          result.push(group('defense', 0, 124, [{ type: 'move_fleet', args: { fleetId: nearby.id, systemId: target.id, x: null, y: null, targetFleetId: null } }], `reinforce occupied target ${target.id}`));
          actionNames.push('move_fleet');
        } else actionNames.push('no timely garrison');
      }
      const preview = settlementPreview(world, actor, war);
      if (preview?.enforced.goals.some(item => item.systemId === target.id && item.eligible)) {
        result.push(group('diplomacy', 0, 123, [{ type: 'enforce_peace', args: { factionId: war.factions.find(id => id !== actor)! } }], `settle controlled objective ${target.id}`));
        actionNames.push('enforce_peace');
      }
      rows.push({ target: target.id, reservePower, threatPower: guardPower, retained: reservePower >= guardPower, actions: actionNames, next: actionNames.includes('enforce_peace') ? 'settle controlled objective' : 'retain garrison and monitor counterattack' });
    }
  }
  return result;
}

function occupationTasks(world: GameState, actor: string, memory: SrasMemory) {
  const rows: CerberusReport['occupation'] = [];
  occupationGroups(world, actor, rows);
  memory.tasks = memory.tasks.filter(task => !task.id.startsWith('occupation:') || rows.some(row => row.target === task.target));
  const assigned = new Set<string>();
  for (const row of rows) {
    let power = 0;
    const fleets = world.fleets.filter(fleet => fleet.ownerId === actor && fleet.systemId === row.target && !fleet.transit && (!fleet.order || fleet.order.systemId === row.target)).sort((a, b) => ownPower(world, actor, b) - ownPower(world, actor, a) || a.id.localeCompare(b.id));
    const assets: string[] = [];
    for (const fleet of fleets) { if (power >= row.threatPower) break; assets.push(fleet.id); assigned.add(fleet.id); power += ownPower(world, actor, fleet); }
    const id = 'occupation:' + row.target, previous = memory.tasks.find(task => task.id === id);
    memory.tasks = memory.tasks.filter(task => task.id !== id);
    memory.tasks.push({ id, expert: 'defense', target: row.target, assets, reserve: {}, stage: 'control', deadline: world.day + 300, evidence: 'actual friendly control and local garrison', lastProgressRound: previous?.lastProgressRound ?? world.round, next: row.next, blockers: row.retained ? [] : ['occupied target requires timely reinforcements'], exit: 'control lost or occupation no longer requires reserve', requiredPower: row.threatPower, status: 'executed' });
  }
  for (const task of memory.tasks.filter(task => !task.id.startsWith('occupation:'))) task.assets = task.assets.filter(id => !assigned.has(id));
}

type ReportWithCerberus = ScriptReport & { cerberus?: CerberusReport };
const budget = { emergency: 32, economy: 48, campaign: 24, fallback: 24 } as const;
function bucket(candidate: RuleGroup): keyof typeof budget {
  if (candidate.priority === 0 || candidate.expert === 'crisis' || candidate.expert === 'defense') return 'emergency';
  if (candidate.expert === 'campaign' || candidate.expert === 'opportunity' || candidate.expert === 'diplomacy') return 'campaign';
  if (candidate.expert === 'endgame') return 'fallback';
  return 'economy';
}

export async function cerberusDecision(world: GameState, actor: string, previous: ScriptMemory | undefined, hooks: PlanningHooks = {}, validator = validateScriptPlan): Promise<Decision> {
  if (world.rulesRevision !== '5.4') throw new Error('SRAS Cerberus requires rules 5.4');
  const started = performance.now(), checkpoint = hooks.checkpoint ?? (async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  await checkpoint(); await hooks.inputAudit?.(structuredClone(world));
  const memory = memoryFor(previous);
  if (previous?.cerberus && previous.cerberus.revision !== SRAS_CERBERUS.revision) throw new Error('Frozen Cerberus revision mismatch; resume this save with its original frozen runtime');
  memory.base.stage = srasStage(world.round + 1, world.config.maxRounds);
  refreshTasks(world, actor, memory.base);
  occupationTasks(world, actor, memory.base);
  const expert = makeExperts(), occupation: CerberusReport['occupation'] = [], conversion: CerberusReport['forceConversion'] = [];
  let stage = new StagingArea(world, actor);
  const selected: { candidate: RuleGroup; status: 'accepted' | 'removed'; reason: string; tasks: SrasMemory['tasks']; count: number }[] = [];
  const initialTasks = structuredClone(memory.base.tasks);
  const blocked: { id: string; expert: RuleGroup['expert']; reason: string }[] = [], spent = { emergency: 0, economy: 0, campaign: 0, fallback: 0 };
  const seen = new Set<string>(), locks = new Set<string>(); let fallback = false;
  const fundingRows: NonNullable<NonNullable<ScriptReport['sras']>['funding']> = [];
  for (let cycle = 0; cycle < SRAS_CERBERUS.previews && stage.actions.length < SRAS_CERBERUS.actions; cycle++) {
    await checkpoint(); const proposed = structuredClone(memory.base);
    const military = militaryRules(stage.draft, actor, proposed);
    const groups = [...responseRules(stage.draft, actor, structuredClone(proposed)), ...economicRules(stage.draft, actor, structuredClone(proposed)), ...military, ...responsibilityRules(stage.draft, actor, structuredClone(proposed)), ...occupationGroups(stage.draft, actor, occupation), ...(fallback ? fallbackRules(stage.draft, actor, structuredClone(proposed)) : [])];
    groups.push(...governanceGroups(stage.draft, actor), ...forceGroups(stage.draft, actor, proposed), ...processingGroups(stage.draft, actor, proposed), ...civilizationGroups(stage.draft, actor, proposed));
    groups.sort((a, b) => a.priority - b.priority || b.rank - a.rank || a.id.localeCompare(b.id));
    const saving = fundingGoal(stage.draft, actor, groups);
    const candidate = groups.find(item => {
      const signature = cerberusDependency(stage.draft, actor, item), type = bucket(item);
      if (seen.has(signature) || !item.actions.length || item.actions.some(action => noChange(stage.draft, action))) return false;
      if (item.actions.some(action => action.type === 'enforce_peace') && stage.actions.some(action => action.type === 'establish_civilization')) return false;
      if (stage.actions.length + item.actions.length > SRAS_CERBERUS.actions) return false;
      if (protectedFunding(stage.draft, actor, item, saving)) {
        if (!blocked.some(row => row.id === item.id)) blocked.push({ id: item.id, expert: item.expert, reason: 'development funding reserved for ' + saving!.candidate.id });
        return false;
      }
      const currentBook = ledger(stage.draft, actor);
      if (item.priority > 1 && currentBook.economy.effectiveUnityChange < 0 && currentBook.normalNet.minerals > SRAS_CERBERUS.foundryMineralMargin && item.actions.some(action => action.type === 'build_structure' && action.args.structureType === 'mine')) {
        if (!blocked.some(row => row.id === item.id)) blocked.push({ id: item.id, expert: item.expert, reason: 'governance recovery: existing mineral production covers operating demand' });
        return false;
      }
      const funds = funding(stage.draft, actor, item.actions);
      if (funds.gaps.length) {
        for (const gap of funds.gaps) if (!fundingRows.some(row => row.id === item.id && row.resource === gap.resource)) fundingRows.push({ id: item.id, ...gap });
        return false;
      }
      if (item.actions.some(action => intentKeys(stage.draft, action).some(intent => locks.has(intent)))) return false;
      if (memory.base.failures.some(failed => failed.id === item.id && failed.dependency === (failed.category === 'cerberus-rule' ? signature : failureDependency(stage.draft, actor, item.actions, failed.category)))) return false;
      if (item.actions.some(action => conflictKeys(action).some(intent => memory.base.switches?.[intent] && world.round - memory.base.switches[intent].round < SRAS.switchCooldownRounds && memory.base.switches[intent].value !== JSON.stringify(action.args))) && item.priority > 0) return false;
      if (fallback) return spent.fallback < budget.fallback;
      if (type === 'fallback') return false;
      const inactive = (Object.keys(budget) as (keyof typeof budget)[]).filter(name => name !== 'fallback' && !groups.some(row => bucket(row) === name));
      return spent[type] < budget[type] + inactive.reduce((sum, name) => sum + Math.max(0, budget[name] - spent[name]), 0) && spent.emergency + spent.economy + spent.campaign < 104;
    });
    if (!candidate) {
      for (const task of proposed.tasks) {
        const prior = memory.base.tasks.find(item => item.id === task.id);
        if (!prior) memory.base.tasks.push({ ...task, assets: [], reserve: {}, status: 'planned' });
        else { prior.next = task.next; prior.blockers = [...task.blockers]; prior.stage = task.stage; prior.rally = task.rally; prior.requiredPower = task.requiredPower; }
      }
      if (!fallback) { fallback = true; continue; } break;
    }
    const signature = cerberusDependency(stage.draft, actor, candidate); seen.add(signature); spent[fallback ? 'fallback' : bucket(candidate)]++;
    const preview = new StagingArea(world, actor); let failure = '';
    for (const action of stage.actions) { const result = preview.execute(action.type, action.args); if (!result.ok) throw new Error('Cerberus certified prefix failed: ' + result.error); }
    const beforeRisk = scheduledRisk(stage.draft, actor).risk;
    for (const action of candidate.actions) {
      if (!safeContactPath(preview.draft, actor, action)) { failure = 'unsafe or unknown contact along movement route'; break; }
      const result = preview.execute(action.type, action.args); if (!result.ok) { failure = result.error ?? 'known validation failed'; break; }
    }
    if (!failure && !deadlineSafe(preview.draft, actor, stage.draft)) failure = 'new project cannot complete before terminal date';
    if (!failure && scheduledRisk(preview.draft, actor).risk > beforeRisk + 1e-6) failure = 'increases linear supply deficit';
    if (!failure && candidate.priority > 1) {
      const before = ledger(stage.draft, actor), after = ledger(preview.draft, actor);
      if (before.economy.effectiveUnityChange < 0 && after.economy.effectiveUnityChange < before.economy.effectiveUnityChange && basics.every(resource => before.normalNet[resource] >= 0)) failure = 'optional action worsens active governance recovery';
    }
    if (!failure && candidate.actions.some(action => action.type === 'set_structure_status' && action.args.sealed === false)) {
      const running = structuredClone(preview.draft);
      for (const planet of running.systems.flatMap(system => system.planets)) for (const structure of planet.structures) if (candidate.actions.some(action => action.args.structureId === structure.id && action.args.sealed === false)) delete structure.restartUntil;
      if (scheduledRisk(running, actor).risk > beforeRisk + 1e-6) failure = 'restart cannot cover normal operating bills';
    }
    if (!failure && candidate.actions.some(action => action.type === 'set_welfare' || action.type === 'establish_civilization') && candidate.expert !== 'crisis') {
      const book = ledger(preview.draft, actor);
      if (book.risk > 0 || basics.some(resource => book.normalNet[resource] < 0) || (world.factions[actor].welfare?.last?.fraction ?? 1) < 1) failure = 'welfare upgrade cannot cover normal bill';
    }
    if (!failure && candidate.actions.some(action => action.type === 'set_jobs' || action.type === 'set_structure_status')) {
      const before = ledger(stage.draft, actor), running = structuredClone(preview.draft);
      for (const planet of running.systems.flatMap(system => system.planets)) for (const structure of planet.structures) if (candidate.actions.some(action => action.args.structureId === structure.id && action.args.sealed === false)) delete structure.restartUntil;
      const after = ledger(running, actor);
      const functional = candidate.actions.some(action => ['shipyard', 'lrs', 'drydock', 'maintenance'].includes(String(action.args.structureType)) || running.systems.flatMap(system => system.planets).some(planet => planet.structures.some(structure => structure.id === action.args.structureId && ['shipyard', 'lrs', 'drydock', 'maintenance'].includes(structure.type))));
      if (!functional && after.economy.effectiveUnityChange <= before.economy.effectiveUnityChange && basics.every(resource => after.net[resource] <= before.net[resource]) && after.economy.net.alloys <= before.economy.net.alloys) failure = 'no current operating or governance benefit';
    }
    if (failure) {
      blocked.push({ id: candidate.id, expert: candidate.expert, reason: failure });
      if (!/supply|bill|benefit|resource|资源|不足|余额/.test(failure)) {
        memory.base.failures = [...memory.base.failures.filter(row => row.id !== candidate.id), { id: candidate.id, actions: candidate.actions, reason: failure, category: 'cerberus-rule', dependency: signature }].slice(-64);
      }
      continue;
    }
    candidate.dependencies = selected.filter(row => row.status === 'accepted' && row.candidate.actions.some(action => candidate.actions.some(next => action.args.planetId && action.args.planetId === next.args.planetId || action.args.fleetId && action.args.fleetId === next.args.fleetId || action.type === 'declare_war' && next.type === 'move_fleet'))).map(row => row.candidate.id);
    for (const action of candidate.actions) for (const intent of intentKeys(stage.draft, action)) locks.add(intent);
    const tasks = acceptedTask(candidate, proposed.tasks);
    if (!tasks.length && !['campaign', 'opportunity', 'defense'].includes(candidate.expert)) tasks.push({ id: `group:${world.round}:${candidate.id}`, expert: candidate.expert, target: String(candidate.actions[0]?.args.planetId ?? candidate.actions[0]?.args.systemId ?? candidate.actions[0]?.args.factionId ?? actor), assets: [], reserve: {}, stage: 'prepare', deadline: world.day + Math.max(100, (world.config.maxRounds - world.round) * 100), evidence: 'accepted group; actual receipt and delivery pending', lastProgressRound: world.round, next: candidate.reason, blockers: [], exit: 'execution rejected, deadline reached or outcome delivered', status: 'accepted', plannedGroup: candidate.id });
    memory.base.tasks = [...memory.base.tasks.filter(task => !tasks.some(next => next.id === task.id)), ...tasks];
    selected.push({ candidate, status: 'accepted', reason: candidate.reason, tasks, count: preview.actions.length - stage.actions.length });
    stage = preview;
  }
  let validations = 1, final = validator(world, actor, stage.actions);
  for (let attempt = 1; !final.ok && attempt < SRAS_CERBERUS.validations; attempt++) {
    let offset = 0;
    const failing = selected.filter(row => row.status === 'accepted').find(row => { offset += row.count; return offset > final.index; });
    if (!failing) break; failing.status = 'removed'; failing.reason = final.reason;
    const removed = new Set([failing.candidate.id]);
    for (const row of selected) if (row.candidate.dependencies.some(id => removed.has(id))) { row.status = 'removed'; row.reason = 'dependency removed'; removed.add(row.candidate.id); }
    final = validator(world, actor, selected.filter(row => row.status === 'accepted').flatMap(row => row.candidate.actions)); validations++;
  }
  if (!final.ok) throw new Error(`SRAS Cerberus final validation failed: ${final.reason}`);
  if (selected.length && !selected.some(row => row.status === 'accepted')) throw new Error('Cerberus final repair removed every group; pause without empty fallback');
  const diagnostics = structuredClone(memory.base.tasks);
  const waiting = memory.base.tasks.filter(task => task.status === 'planned' && !task.assets.length);
  memory.base.tasks = [...structuredClone(initialTasks), ...waiting.filter(task => !initialTasks.some(initial => initial.id === task.id))];
  for (const row of selected.filter(row => row.status === 'accepted')) {
    memory.base.tasks = [...memory.base.tasks.filter(task => !row.tasks.some(next => next.id === task.id)), ...row.tasks];
    for (const action of row.candidate.actions) for (const intent of conflictKeys(action)) if (intent.startsWith('structure:') || intent.startsWith('jobs:')) (memory.base.switches ??= {})[intent] = { round: world.round, value: JSON.stringify(action.args) };
  }
  for (const task of memory.base.tasks) {
    const latest = diagnostics.find(item => item.id === task.id);
    if (latest && !selected.some(row => row.status === 'removed' && row.tasks.some(item => item.id === task.id))) { task.next = latest.next; task.blockers = latest.blockers; task.stage = latest.stage; }
  }
  const allocated = new Set<string>();
  for (const task of memory.base.tasks) if (task.stage === 'exit' || task.status === 'planned') { task.assets = []; task.reserve = {}; }
  for (const task of [...memory.base.tasks].sort((a, b) => Number(b.expert === 'defense') - Number(a.expert === 'defense') || a.id.localeCompare(b.id))) task.assets = task.assets.filter(id => { if (allocated.has(id) || !final.stage.draft.fleets.some(fleet => fleet.id === id && fleet.ownerId === actor)) return false; allocated.add(id); return true; });
  const actions = final.ok ? final.stage.actions : [];
  const book = ledger(world, actor);
  const accepted = selected.filter(row => row.status === 'accepted'), planned = selected.reduce((sum, row) => sum + row.candidate.actions.length, 0);
  const quality = { planned, submitted: actions.length, accepted: accepted.reduce((sum, row) => sum + row.candidate.actions.length, 0), executed: 0, completed: 0, stateChanges: new Set(actions.map(actionKey)).size, military: conversion.length, governance: expert['governance-recovery'].actions };
  const report: ReportWithCerberus = { version: SRAS_CERBERUS.version, candidates: seen.size, forecasts: 0, validations: final.ok ? 1 : SRAS_CERBERUS.validations, exhausted: seen.size >= SRAS_CERBERUS.previews, alternatives: [], selected: accepted.map(row => ({ id: row.candidate.id, label: row.candidate.expert + ': ' + row.reason, actions: row.candidate.actions, fingerprint: row.candidate.id })), rejected: [], assumptions: 'Pure current-state rules; coordinated task ledger; no models, forecasts, search or combat simulation.', sras: { revision: SRAS_CERBERUS.revision, stage: memory.base.stage, triggers: [], tasks: structuredClone(memory.base.tasks), previews: seen.size, actions: actions.length, stop: actions.length ? 'coordinated executable groups accepted' : 'fallback checked; no executable action', normalNet: book.normalNet, reserves: book.reserves, deficits: book.deficits, groups: selected.map(row => ({ id: row.candidate.id, expert: row.candidate.expert, actions: row.candidate.actions, dependencies: row.candidate.dependencies, status: row.status, reason: row.reason })), blocked, fallback: [], counters: { unique: seen.size, duplicates: 0, conflicts: 0, accepted: accepted.length, rejected: blocked.length }, budget: spent, removed: selected.filter(row => row.status === 'removed').map(row => ({ id: row.candidate.id, reason: row.reason })) } };
  report.validations = validations;
  report.sras!.funding = fundingRows;
  memory.base.waiting = fundingRows.slice(0, 3).map(row => ({ id: row.id, reason: `${row.resource} gap ${row.gap}; normal net ${row.normalNet}`, earliestDay: row.earliestDay }));
  report.sras!.fallback = fallbackChecks(final.stage.draft, actor, memory.base, blocked);
  report.sras!.stop = actions.length >= 48 ? '48 expanded actions' : seen.size >= 128 ? 'preview budget exhausted; usage recorded' : blocked.length ? 'remaining opportunities blocked; see per-group evidence and fallback checks' : 'rules checked; waiting for queue completion, intelligence or task conditions';
  for (const name of Object.keys(expert) as (keyof typeof expert)[]) expert[name].checked = 1;
  for (const row of accepted) {
    if (row.reason.startsWith('governance-recovery:')) expert['governance-recovery'].actions += row.count;
    for (const action of row.candidate.actions) if (action.type === 'queue_ships') {
      conversion.push({ planetId: String(action.args.planetId), shipType: String(action.args.shipType), count: Number(action.args.count), reason: row.reason });
      expert['force-conversion'].actions++;
    }
    if (/occupied|garrison|controlled objective/.test(row.reason)) expert['occupation-garrison'].actions += row.count;
    if (row.candidate.actions.some(action => action.type === 'establish_civilization')) expert['civilization-conversion'].actions += row.count;
  }
  quality.military = expert['force-conversion'].actions;
  quality.governance = expert['governance-recovery'].actions;
  for (const name of Object.keys(expert) as (keyof typeof expert)[]) if (!expert[name].actions) expert[name].blockers = blocked.filter(row => row.reason.includes(name)).map(row => row.reason);
  report.cerberus = { ...report.sras!, revision: SRAS_CERBERUS.revision, experts: expert, quality: { ...quality, acceptedRate: planned ? quality.accepted / planned : 1, executedRate: 0, stateChangeRate: actions.length ? quality.stateChanges / actions.length : 1 }, occupation: [...new Map(occupation.map(row => [row.target, row])).values()], forceConversion: conversion };
  const reserved = memory.base.tasks.flatMap(task => task.assets), resources = Object.fromEntries(memory.base.tasks.flatMap(task => Object.entries(task.reserve)).reduce((map, [resource, amount]) => map.set(resource, (map.get(resource) ?? 0) + amount), new Map<string, number>()));
  const cerberus: CerberusMemory = { ...memory, baseline: realizedAssets(world, actor), realized: undefined, revision: SRAS_CERBERUS.revision, quality, tasks: memory.base.tasks, reserved: { fleets: reserved, resources } };
  return { actions, summary: `SRAS Cerberus ${memory.base.stage}: ${actions.length} actions; ${report.sras!.stop}`, trace: final.ok ? final.stage.trace : [], scriptMemory: { version: SRAS_CERBERUS.version, goal: null, tasks: [], failures: [], cerberus } as ScriptMemory, scriptReport: report, metrics: { ...emptyMetrics(), durationMs: performance.now() - started, reportedModel: SRAS_CERBERUS.version } };
}
