import { constructionView } from '../shared/construction.js';
import { allocation, LABOR, support, shipMaterials, capacity, INDUSTRY } from '../shared/industry.js';
import { SHIPS, STRUCTURES } from '../shared/rules.js';
import type { GameState, Action } from '../shared/types.js';
import type { SrasMemory } from '../shared/sras11.js';
import { SRAS_CERBERUS } from '../shared/sras13.js';
import { basics, group, ledger, owned, remaining, ownPower, arrival, digest, type RuleGroup } from './sras11-rules.js';
import { candidateDependency } from './sras11-response.js';
import { nextShipLineDay } from './sras13-coordination.js';
import { fleetDemand } from './sras11-experts.js';
import { civilizationEligibility, route, CIVILIZATION } from '../shared/civilization.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { faithEffects } from '../shared/v4.js';
import { annexationFactor } from '../shared/balance.js';

export function cerberusDependency(state: GameState, actor: string, candidate: RuleGroup) {
  const faction = state.factions[actor];
  const claims = candidate.actions.some(action => action.type === 'create_claim') ? state.claims?.filter(claim => claim.factionId === actor && claim.expiresDay > state.day) : undefined;
  const preparations = candidate.actions.some(action => action.type === 'prepare_conquest') ? state.conquests?.filter(item => item.actor === actor && item.endedDay === undefined).map(item => ({ target: item.target, ready: item.readyDay <= state.day })) : undefined;
  const policy = candidate.actions.some(action => action.type === 'choose_policy') ? faction.policy : undefined;
  return digest({ local: candidateDependency(state, actor, candidate), claims, preparations, policy });
}

export function processingGroups(state: GameState, actor: string, memory?: SrasMemory): RuleGroup[] {
  const result: RuleGroup[] = [], book = ledger(state, actor), faction = state.factions[actor];
  const systems = owned(state, actor), planets = systems.flatMap(system => system.planets.filter(planet => planet.ownerId === actor));
  const yards = planets.filter(planet => support({ ...planet, operation: undefined }, 'shipyard', state.day) > 0).length;
  const paid = systems.flatMap(system => system.projects).filter(project => project.structureType === 'foundry').length;
  const ships = systems.flatMap(system => system.projects).filter(project => project.shipType);
  const taskDemand = memory ? fleetDemand(state, actor, memory).gap : 0;
  const needed = ships.length > 0 || taskDemand > 0 || state.round >= state.config.maxRounds / 3 && faction.resources.minerals / 1000 > book.reserves.minerals + SRAS_CERBERUS.terminalReserve;
  const types = ships.length ? ships.map(project => project.shipType!) : ['cruiser' as const];
  const demand = needed ? yards * Math.max(...types.map(type => (shipMaterials(type).alloys ?? 0) / 1000 / SHIPS[type].days * 100)) * (.5 + faction.unity / 10000) : 0;
  if (!yards || book.risk > 0 || book.normalNet.minerals <= SRAS_CERBERUS.foundryMineralMargin || faction.resources.minerals / 1000 <= book.reserves.minerals + SRAS_CERBERUS.terminalReserve || book.economy.net.alloys + paid * 30 >= demand || remaining(state) <= STRUCTURES.foundry.days + SHIPS.cruiser.days) return result;
  for (const system of systems) for (const planet of system.planets.filter(item => item.ownerId === actor)) {
    const queue = system.projects.filter(project => project.planetId === planet.id);
    if (queue.some(project => project.structureType === 'foundry')) continue;
    const foundries = planet.structures.filter(structure => structure.type === 'foundry');
    const sealed = foundries.find(structure => structure.sealed);
    if (sealed) {
      const actions: Action[] = [{ type: 'set_structure_status', args: { planetId: planet.id, structureId: sealed.id, sealed: false } }];
      if ((planet.priorities?.foundry ?? LABOR.foundry.priority) !== 5) actions.push({ type: 'set_jobs', args: { planetId: planet.id, structureType: 'foundry', priority: 5 } });
      result.push(group('economy', 2, 115, actions, 'force-conversion: restore paid alloy capacity for staffed shipyard demand'));
      continue;
    }
    if (foundries.length >= LABOR.foundry.limit) continue;
    const slot = STRUCTURES.foundry.slot;
    const used = planet.structures.filter(structure => STRUCTURES[structure.type].slot === slot).length + queue.filter(project => project.structureType && STRUCTURES[project.structureType].slot === slot).length;
    if (used >= capacity(planet, slot)) {
      if (!queue.some(project => project.kind === 'expansion')) result.push(group('economy', 2, 108, [{ type: 'expand_slots', args: { planetId: planet.id, slot } }], 'force-conversion: slot reserved for alloy production serving staffed shipyards'));
      continue;
    }
    let free = planet.population - planet.structures.filter(structure => !structure.sealed).reduce((sum, structure) => sum + LABOR[structure.type].jobs, 0) - queue.reduce((sum, project) => sum + (project.structureType ? LABOR[project.structureType].jobs : 0), 0);
    const actions: Action[] = [];
    const copy = structuredClone(state), copied = copy.systems.flatMap(item => item.planets).find(item => item.id === planet.id)!;
    for (const mine of planet.structures.filter(structure => structure.type === 'mine' && !structure.sealed).sort((a, b) => a.id.localeCompare(b.id))) {
      if (free >= LABOR.foundry.jobs) break;
      copied.structures.find(structure => structure.id === mine.id)!.sealed = true; delete copied.operation;
      if (ledger(copy, actor).normalNet.minerals <= SRAS_CERBERUS.foundryMineralMargin) break;
      actions.push({ type: 'set_structure_status', args: { planetId: planet.id, structureId: mine.id, sealed: true } }); free += LABOR.mine.jobs;
    }
    if (free >= LABOR.foundry.jobs) result.push(group('economy', 2, 110, [...actions, { type: 'build_structure', args: { planetId: planet.id, structureType: 'foundry' } }], 'force-conversion: mineral surplus into alloy throughput with released labor'));
  }
  return result;
}

export function governanceGroups(state: GameState, actor: string): RuleGroup[] {
  const book = ledger(state, actor), result: RuleGroup[] = [], faction = state.factions[actor];
  if (book.economy.effectiveUnityChange >= 0) return result;
  const priority = faction.unity < SRAS_CERBERUS.governanceEmergency * 100 ? 1 : 2;
  for (const system of owned(state, actor)) for (const planet of system.planets.filter(item => item.ownerId === actor)) {
    const jobs = allocation({ ...planet, operation: undefined }, state.day);
    for (const structure of [...planet.structures].sort((a, b) => a.id.localeCompare(b.id))) {
      if (structure.type === 'mine' && !structure.sealed && (jobs[structure.id] ?? 0) > 0 && book.normalNet.minerals > 0) {
        const copy = structuredClone(state);
        const target = copy.systems.flatMap(item => item.planets).find(item => item.id === planet.id)!;
        target.structures.find(item => item.id === structure.id)!.sealed = true; delete target.operation;
        const next = ledger(copy, actor);
        if (next.normalNet.minerals >= 0 && next.risk <= book.risk && next.economy.effectiveUnityChange > book.economy.effectiveUnityChange) result.push(group('economy', priority, 130, [{ type: 'set_structure_status', args: { planetId: planet.id, structureId: structure.id, sealed: true } }], 'governance-recovery: reduce mining burden with sustained mineral production'));
      }
      if (['sanatorium', 'resort'].includes(structure.type)) {
        const actions: Action[] = [];
        if (structure.sealed) actions.push({ type: 'set_structure_status', args: { planetId: planet.id, structureId: structure.id, sealed: false } });
        if ((jobs[structure.id] ?? 0) < 1 && (planet.priorities?.[structure.type] ?? LABOR[structure.type].priority) !== 5) actions.push({ type: 'set_jobs', args: { planetId: planet.id, structureType: structure.type, priority: 5 } });
        if (actions.length) result.push(group('economy', priority, 125, actions, 'governance-recovery: operate paid recovery capacity with staffing'));
      }
    }
    const free = planet.population - planet.structures.filter(structure => !structure.sealed).reduce((sum, structure) => sum + LABOR[structure.type].jobs, 0);
    if (faction.unity < SRAS_CERBERUS.governanceTrigger * 100 && book.risk === 0 && free >= LABOR.sanatorium.jobs && remaining(state) > STRUCTURES.sanatorium.days && !planet.structures.some(structure => structure.type === 'sanatorium') && !system.projects.some(project => project.planetId === planet.id && project.structureType === 'sanatorium')) {
      result.push(group('economy', priority, 126, [{ type: 'build_structure', args: { planetId: planet.id, structureType: 'sanatorium' } }], 'governance-recovery: staffed recovery facility for current negative cohesion'));
    }
  }
  return result;
}

export function civilizationGroups(state: GameState, actor: string, memory: SrasMemory): RuleGroup[] {
  const result: RuleGroup[] = [], faction = state.factions[actor], book = ledger(state, actor);
  if (book.risk > 0 || basics.some(resource => book.normalNet[resource] < 0) || (faction.welfare?.last?.fraction ?? 1) < 1) return result;
  const necessaryDefense = memory.tasks.some(task => task.expert === 'defense' && task.stage !== 'exit' && task.blockers.length > 0);
  const welfare = faction.welfare;
  if (welfare && !necessaryDefense && route(state, actor) !== 'militarist' && (welfare.firstChoice || state.day >= welfare.selectedDay + CIVILIZATION.welfareCooldown) && remaining(state) > 300) {
    const levels = ['survival', 'basic', 'comfortable', 'welfare', 'utopian'] as const;
    const index = levels.indexOf(welfare.choice as typeof levels[number]);
    if (index >= 0 && index < levels.length - 1) result.push(group('economy', 3, 75, [{ type: 'set_welfare', args: { welfare: levels[index + 1] } }], 'civilization-conversion: normal bills and committed defense before affordable welfare'));
  }
  if (route(state, actor) !== 'secular' || !civilizationEligibility(state, actor, 'militarist').allowed || remaining(state) < 720 || book.economy.effectiveUnityChange < 0) return result;
  for (const war of state.wars?.filter(war => war.endedDay === undefined && war.factions.includes(actor)) ?? []) {
    const view = settlementPreview(state, actor, war);
    if (!view?.enforced.goals.some(goal => goal.eligible) || necessaryDefense) continue;
    result.push(group('diplomacy', 0, 124, [{ type: 'establish_civilization', args: { civilization: 'militarist', acknowledgePermanent: true } }], 'civilization-conversion: establish before next-round objective settlement; common settlement orders diplomacy before institutions'));
  }
  return result;
}

export function forceGroups(state: GameState, actor: string, memory: SrasMemory): RuleGroup[] {
  const result: RuleGroup[] = [], book = ledger(state, actor), faction = state.factions[actor];
  if (book.risk > 0 || basics.some(resource => book.normalNet[resource] < 0)) return result;
  const tasks = memory.tasks.filter(task => task.stage !== 'exit' && ['defense', 'campaign'].includes(task.expert));
  const requested = fleetDemand(state, actor, memory).gap;
  const surplus = faction.resources.minerals / 1000 - book.reserves.minerals - SRAS_CERBERUS.terminalReserve;
  if (requested <= 0 && (state.round < 40 || surplus <= 0 || (faction.resources.alloys ?? 0) / 1000 < SRAS_CERBERUS.terminalAlloys)) return result;
  if (faction.unity < SRAS_CERBERUS.governanceEmergency * 100 && book.economy.effectiveUnityChange < 0 && !tasks.some(task => task.expert === 'defense')) return result;
  for (const system of owned(state, actor)) for (const planet of system.planets.filter(item => item.ownerId === actor)) {
    if (support({ ...planet, operation: undefined }, 'shipyard', state.day) < 1) continue;
    const queue = constructionView(state, system, planet).queues.find(item => item.slot === 'ship')!;
    if (queue.projects.length >= queue.lines * 2) continue;
    const availableDay = nextShipLineDay(state.day, queue);
    const productivity = (.5 + faction.unity / 10000) * support({ ...planet, operation: undefined }, 'shipyard', state.day) * (1 + INDUSTRY.bonus * support({ ...planet, operation: undefined }, 'drydock', state.day)) * faithEffects(faction, state.day).production * annexationFactor(system, state.day) * (route(state, actor) === 'militarist' ? CIVILIZATION.militaryShipSpeed : 1);
    const types = (Object.keys(SHIPS) as (keyof typeof SHIPS)[]).filter(type => availableDay + Math.ceil(SHIPS[type].days / productivity / 10) * 10 <= state.day + remaining(state)).sort((a, b) => SHIPS[b].power / SHIPS[b].days - SHIPS[a].power / SHIPS[a].days || SHIPS[a].minerals - SHIPS[b].minerals || a.localeCompare(b));
    for (const type of types) {
      const price = shipMaterials(type);
      if (faction.resources.minerals < price.minerals + book.reserves.minerals * 1000 || (faction.resources.alloys ?? 0) < (price.alloys ?? 0)) continue;
      const completeDay = availableDay + Math.ceil(SHIPS[type].days / productivity / 10) * 10;
      const hull = { id: 'prospective', name: '', ownerId: actor, systemId: system.id, position: planet.position, transit: null, order: null, ships: [{ id: 'prospective', type, hull: SHIPS[type].power }] };
      const deliverable = tasks.map(task => ({ task, day: completeDay + arrival(state, actor, hull, task.rally ?? task.target) })).filter(row => row.day <= row.task.deadline).sort((left, right) => Number(right.task.expert === 'defense') - Number(left.task.expert === 'defense') || left.day - right.day || left.task.id.localeCompare(right.task.id))[0];
      result.push(group('economy', requested > 0 && deliverable ? 2 : 4, 90 + SHIPS[type].power / SHIPS[type].days, [{ type: 'queue_ships', args: { planetId: planet.id, shipType: type, count: 1 } }], `force-conversion: ${deliverable ? deliverable.task.id + '; delivery ' + deliverable.day : 'rear recovery or terminal conversion; not counted as timely defense'}; ${type}; completion ${completeDay}`));
    }
  }
  return result;
}
