import { settleExtractionGrant, applyExtractionRecovery } from './emergency.js';
import { emergencyRules } from '../shared/emergency.js';
import { governed, recordGovernance, actionLimit } from '../shared/governance.js';
import { responsible, decisionBalanced } from '../shared/responsibility.js';
import { updateSocial } from './social.js';
import { CIVILIZATION, modern, route, utopiaOperating, welfareQuote } from '../shared/civilization.js';
import { settleWelfare, trackCivilization } from './civilization.js';
import { industrial, freezeOperations, shipMaterials } from '../shared/industry.js';
import { BALANCE, balancedRules, civilizationScore, holyCooperation, warBurden } from '../shared/balance.js';
import { finishBalanceInterval } from './balance.js';
import { updateEscalation } from './escalation.js';
import { revised } from '../shared/escalation.js';
import { cohesionBreakdown, currentPolicy, POLICIES, supplyFactor } from '../shared/civil.js';
import { controller, faithEffects, fleetValue, operational } from '../shared/v4.js';
import { accountBattleLosses, restoreBases, settleCaptures, settleWar, updateWars } from './wars.js';
import { discoverHoly, finishConsecrations, trackBeacon, updateFaith } from './religion.js';
import { updatePolicies } from './policies.js';
import { BASE, factionIds, factionRecord, RULES, SHIPS, units } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Action, Fleet, GameState, LocalEvent, Resources } from '../shared/types.js';
import { applyAction, expandOrder } from './actions.js';
import { refreshIntel, militarySystems } from './intel.js';
import type { FactionFactors, LocalInput, LocalOutput } from './local.js';
import { distance, randomGenerator } from './math.js';
import { SimulationPool } from './pool.js';

const resources = (): Resources => ({ energy: 0, food: 0, minerals: 0 });

import { accessiblePath, DIPLOMATIC_ACTIONS, diplomacyEvent, markContactWars, updateContacts, updateDiplomacy } from './diplomacy.js';
import { factionScores } from '../shared/scoring.js';

export function appendEvents(state: GameState, events: LocalEvent[]) {
  const ordered = [...events].sort((first, second) => (first.systemId ?? '').localeCompare(second.systemId ?? '') || first.type.localeCompare(second.type) || first.text.localeCompare(second.text));
  let sequence = Math.max(state.events.filter(event => event.day === state.day).length, ...state.events.filter(event => event.day === state.day && /^\d+-\d+$/.test(event.id)).map(event => Number(event.id.split('-')[1]) + 1));
  for (const event of ordered) state.events.push({ ...event, round: state.round + 1, id: `${state.day}-${sequence++}` });
}

export function commitActions(original: GameState, actions: Record<FactionId, Action[]>): GameState {
  if (governed(original)) {
    actions = Object.fromEntries(Object.entries(actions).map(([actor,orders])=>{
      const expanded=orders.flatMap(order=>expandOrder(order.type,order.args));
      if(expanded.length>actionLimit(original))throw new Error('共同结算拒绝：展开动作超过48条');
      return [actor,expanded];
    }));
  }
  let state = structuredClone(original);
  const entries = factionIds(state).flatMap(factionId => (actions[factionId] ?? []).map((action, index) => ({ factionId, action, index })));
  const priority = (type: string) => responsible(state)&&['accept_stop_extraction','stop_extraction','accept_reform','accept_aid','reject_aid','reject_reform'].includes(type)?1:responsible(state)&&['set_welfare','establish_civilization','establish_religion'].includes(type)?4:type === 'withdraw_peace' ? 0 : type === 'accept_peace' ? 1 : DIPLOMATIC_ACTIONS.includes(type) ? 2 : revised(state) && type === 'cancel_conquest' ? 3 : revised(state) && !modern(state) && type === 'prepare_conquest' ? 4 : 5;
  entries.sort((first, second) => priority(first.action.type) - priority(second.action.type) || first.factionId.localeCompare(second.factionId) || first.index - second.index);
  for (const { factionId, action, index } of entries) {
    if (state.factions[factionId].eliminatedDay !== undefined) continue;
    const candidate = structuredClone(state);
    try {
      const beforeResources = { ...state.factions[factionId].resources };
      const result = applyAction(candidate, factionId, action, `${factionId}-r${state.round}-a${index}`);
      state = candidate;
      appendEvents(state, [{ day: state.day, type: 'order', details: { action: structuredClone(action), factionId, accepted: true, result: structuredClone(result), beforeResources, afterResources: { ...state.factions[factionId].resources } }, text: `${state.factions[factionId].name}提交 ${action.type}`, systemId: null, audience: [factionId] }]);
    } catch (error) {
      if(responsible(state)&&action.type==='build_starbase'){
        const target=action.args.systemId as string,f=state.factions[factionId],key=action.type+':'+target;
        const prior=f.failedOrders?.[key];
        (f.failedOrders??={})[key]={type:action.type,target,count:(prior?.count??0)+1,day:state.day,intelDay:Math.max(f.intel[target]?.day??-1,f.militaryIntel?.[target]?.day??-1),reason:'目标在共同结算时已不满足基地施工条件'};
      }
      appendEvents(state, [{ day: state.day, type: 'order', details: { action, factionId, accepted: false, reason: error instanceof Error ? error.message : '命令失效' }, text: `${action.type}结算冲突：${error instanceof Error ? error.message : '命令失效'}`, systemId: null, audience: [factionId] }]);
    }
  }
  updateEscalation(state, 0);
  for (const system of state.systems) {
    const competing = system.projects.filter(project => project.kind === 'base');
    if (new Set(competing.map(project => project.ownerId)).size < 2) continue;
    const sorted = [...competing].sort((first, second) => first.ownerId.localeCompare(second.ownerId));
    const winner = sorted[Math.floor(randomGenerator(`${state.config.seed}:${state.day}:${system.id}:claim`)() * sorted.length)];
    for (const project of competing) if (project !== winner) {
      for (const resource of ['energy', 'food', 'minerals'] as const) state.factions[project.ownerId].resources[resource] += project.cost[resource];
      system.projects = system.projects.filter(candidate => candidate !== project);
      appendEvents(state, [{ day: state.day, type: 'order', text: `${system.name}施工权争夺：${state.factions[winner.ownerId].name}获得施工权，另一方全额退款`, systemId: system.id, audience: factionIds(state) }]);
    }
  }
  return state;
}

function arrive(state: GameState) {
  for (const fleet of state.fleets) {
    delete fleet.previousPosition;
    delete fleet.departedDay;
    delete fleet.movementDays;
    if (!fleet.transit) continue;
    fleet.transit.remainingDays -= RULES.tickDays;
    if (fleet.transit.remainingDays > 0) continue;
    const destination = state.systems.find(system => system.id === fleet.transit!.to)!;
    fleet.movementDays = Math.min(RULES.tickDays, -fleet.transit.remainingDays);
    fleet.position = { ...destination.gates[fleet.transit.from] };
    fleet.systemId = destination.id;
    fleet.transit = null;
    appendEvents(state, [{ day: state.day, type: 'movement', text: `${fleet.name}抵达${destination.name}`, systemId: destination.id, audience: [fleet.ownerId] }]);
  }
}

function updatePursuit(state: GameState) {
  const visibility = factionRecord(factionIds(state), id => militarySystems(state, id));
  for (const fleet of state.fleets) {
    if (!fleet.systemId || !fleet.order?.targetFleetId) continue;
    const target = state.fleets.find(candidate => candidate.id === fleet.order!.targetFleetId && candidate.ownerId !== fleet.ownerId && candidate.systemId && visibility[fleet.ownerId].has(candidate.systemId));
    if (!target?.systemId) { fleet.order.targetFleetId = null; continue; }
    fleet.order.systemId = target.systemId;
    fleet.order.position = { ...target.position };
    fleet.order.route = accessiblePath(state, fleet.ownerId, fleet.systemId, target.systemId) ?? [];
  }
}

export function mergePhase(state: GameState, phase: LocalInput['phase'], outputs: LocalOutput[]) {
  const bySystem = new Map(outputs.flatMap(output => output.systems).map(system => [system.id, system]));
  state.systems = state.systems.map(system => bySystem.get(system.id)!);
  const processedIds = new Set(outputs.flatMap(output => output.fleets).map(fleet => fleet.id));
  const untouchedTransit = state.fleets.filter(fleet => !fleet.systemId && !processedIds.has(fleet.id) && !(phase === 'combat' && fleet.departedDay === state.day));
  state.fleets = [...outputs.flatMap(output => output.fleets), ...untouchedTransit].sort((first, second) => first.id.localeCompare(second.id));
  appendEvents(state, outputs.flatMap(output => output.events));
  if (phase === 'combat') {
    markContactWars(state, outputs.flatMap(output => output.battles));
    settleCaptures(state, outputs.flatMap(output => output.captures).sort((first, second) => first.systemId.localeCompare(second.systemId)));
  }
  finishConsecrations(state, outputs.flatMap(output => output.consecrations).sort((first, second) => first.planetId.localeCompare(second.planetId) || first.actor.localeCompare(second.actor)));
  for (const survey of outputs.flatMap(output => output.surveys).sort((first, second) => first.systemId.localeCompare(second.systemId) || first.factionId.localeCompare(second.factionId))) {
    const faction = state.factions[survey.factionId];
    if (!faction.surveyed.includes(survey.systemId)) faction.surveyed.push(survey.systemId);
    const system = structuredClone(state.systems.find(candidate => candidate.id === survey.systemId)!);
    system.projects = system.projects.filter(project => project.ownerId === survey.factionId);
    faction.intel[survey.systemId] = { day: state.day, system, fleets: [] };
    discoverHoly(state, survey.factionId, system);
  }
}

export function settleEconomy(state: GameState, outputs: LocalOutput[], previousFactors: Record<FactionId, FactionFactors>, capture: boolean) {
  const before = capture ? Object.fromEntries(factionIds(state).map(id => [id, { resources: { ...state.factions[id].resources }, unity: state.factions[id].unity, shortages: { ...state.factions[id].shortages } }])) : {};
  const income = factionRecord(factionIds(state), resources);
  const upkeep = factionRecord(factionIds(state), resources);
  for (const output of outputs) for (const factionId of factionIds(state)) for (const resource of ['energy', 'food', 'minerals'] as const) {
    income[factionId][resource] += output.income[factionId][resource];
    upkeep[factionId][resource] += output.upkeep[factionId][resource];
  }
  for (const fleet of state.fleets.filter(fleet => !fleet.systemId)) for (const ship of fleet.ships) {
    upkeep[fleet.ownerId].energy += units(SHIPS[ship.type].energy * RULES.tickDays / RULES.daysPerRound * (previousFactors[fleet.ownerId].warUpkeep ?? 1));
    upkeep[fleet.ownerId].minerals += units(SHIPS[ship.type].upkeep * RULES.tickDays / RULES.daysPerRound * (previousFactors[fleet.ownerId].warUpkeep ?? 1));
  }
  for (const id of factionIds(state)) settleExtractionGrant(state,id,income[id],upkeep[id],outputs,previousFactors[id]);
  const baseShortages = modern(state) ? Object.fromEntries(factionIds(state).map(id => [id, settleWelfare(state, id, income[id], upkeep[id], previousFactors[id].welfareQuote)])) : null;
  const processing: unknown[] = [];
  if (industrial(state)) for (const factionId of factionIds(state)) {
    const faction = state.factions[factionId];
    const demands = outputs.flatMap(o => o.processing).filter(p => p.actor === factionId).sort((a,b) => a.systemId.localeCompare(b.systemId) || a.planetId.localeCompare(b.planetId));
    const requested = demands.reduce((n,p) => n + p.input, 0);
    const budget = Math.min(requested, Math.max(0, Math.min(faction.resources.minerals, previousFactors[factionId].openingMinerals ?? faction.resources.minerals) - upkeep[factionId].minerals));
    const grants = demands.map(p => requested ? Math.floor(budget * p.input / requested) : 0);
    let remainder = budget - grants.reduce((a,b) => a+b, 0);
    for (let i = 0; i < demands.length; i++) {
      if (remainder > 0) { grants[i]++; remainder--; }
      const p = demands[i], produced = p.input ? Math.floor(p.output * grants[i] / p.input) : 0;
      upkeep[factionId].minerals += grants[i];
      income[factionId].alloys = (income[factionId].alloys ?? 0) + produced;
      processing.push({ ...p, consumed: grants[i], produced, openingMinerals: previousFactors[factionId].openingMinerals ?? faction.resources.minerals, budget, requested });
    }
    faction.resources.alloys = (faction.resources.alloys ?? 0) + (income[factionId].alloys ?? 0);
    faction.lastIncome.alloys = (faction.lastIncome.alloys ?? 0) + (income[factionId].alloys ?? 0);
  }
  for (const factionId of factionIds(state)) {
    const faction = state.factions[factionId];
    const oldShortages = { ...faction.shortages };
    for (const resource of ['energy', 'food', 'minerals'] as const) {
      const available = faction.resources[resource] + income[factionId][resource];
      faction.shortages[resource] = available < upkeep[factionId][resource];
      faction.resources[resource] = Math.max(0, available - upkeep[factionId][resource]);
      faction.lastIncome[resource] += income[factionId][resource] - upkeep[factionId][resource];
    }
    if (baseShortages) faction.shortages = baseShortages[factionId];
    const short = faction.shortages;
    const populationDetails=outputs.flatMap(o=>o.economicDetails).filter(d=>d.factionId===factionId);
    if(decisionBalanced(state)) populationDetails.sort((a,b)=>a.systemId.localeCompare(b.systemId)||a.planetId.localeCompare(b.planetId));
    if(modern(state) && !Object.values(short).some(Boolean)) for(const detail of populationDetails) {
      const system=state.systems.find(s=>s.id===detail.systemId)!,planet=system.planets.find(p=>p.id===detail.planetId)!;
      if(controller(system)!==system.ownerId) continue;
      const cap=detail.populationCap??16;
      const growth=Math.min(2,(detail.nonUtopiaGrowth??1)*(utopiaOperating(state,factionId)?CIVILIZATION.utopiaGrowth:1));
      detail.growthDays=planet.population<cap?RULES.tickDays*growth*detail.annexationMultiplier:0;
      planet.growthDays+=detail.growthDays;
      if(planet.population<cap && planet.growthDays>=RULES.populationGrowthDays){planet.population++;planet.growthDays-=RULES.populationGrowthDays;appendEvents(state,[{day:state.day,type:'population',text:`${planet.name}人口增长至${planet.population}`,systemId:system.id,audience:[factionId]}]);}
      if(planet.population>=cap)planet.growthDays=0;
    }
    const cohesionState = { ...state, day: state.day - RULES.tickDays, factions: { ...state.factions, [factionId]: { ...faction, faith: previousFactors[factionId].faith, beacon: previousFactors[factionId].beacon } } };
    const cohesion = cohesionBreakdown(cohesionState, factionId, oldShortages);
    faction.unity = Math.max(0, Math.min(10000, faction.unity + Math.round((cohesion.total + (balancedRules(state) ? (previousFactors[factionId].warUnity ?? 0) - (cohesion.war ?? 0) : 0)) * RULES.tickDays)));
    if (JSON.stringify(oldShortages) !== JSON.stringify(short)) appendEvents(state, [{ day: state.day, type: 'economy', text: `${faction.name}供应状态：${Object.entries(short).filter(([, value]) => value).map(([resource]) => ({ energy: '电力', food: '食物', minerals: '矿物维护' })[resource]).join('、') || '供应恢复正常'}`, systemId: null, audience: [factionId] }]);
    if (Object.values(previousFactors[factionId].shortages).some(Boolean)) continue;
    const repair = (hull: number, maximum: number, cost: number, alloyCost = 0) => {
      let amount = Math.min(maximum - hull, maximum * RULES.repairFractionPerRound * RULES.tickDays / RULES.daysPerRound);
      if (industrial(state) && amount > 0) {
        const wantedM = units(cost * RULES.repairCostFraction * amount / maximum), wantedA = units(alloyCost * RULES.repairCostFraction * amount / maximum);
        amount *= Math.min(1, wantedM ? faction.resources.minerals / wantedM : 1, wantedA ? (faction.resources.alloys ?? 0) / wantedA : 1);
      }
      const price = units(cost * RULES.repairCostFraction * amount / maximum);
      const alloyPrice = units(alloyCost * RULES.repairCostFraction * amount / maximum);
      if (amount <= 0 || faction.resources.minerals < price) return hull;
      faction.resources.minerals -= price;
      if (industrial(state)) { faction.resources.alloys = Math.max(0, (faction.resources.alloys ?? 0) - alloyPrice); faction.lastIncome.alloys = (faction.lastIncome.alloys ?? 0) - alloyPrice; }
      faction.lastIncome.minerals -= price;
      return Math.round((hull + amount) * 1000) / 1000;
    };
    for (const system of state.systems) if (controller(system) === factionId && system.base && operational(system, state.day - RULES.tickDays)) {
      system.base.hull = repair(system.base.hull, BASE.power, BASE.minerals);
      for (const fleet of state.fleets.filter(candidate => candidate.ownerId === factionId && candidate.systemId === system.id && distance(candidate.position, { x: 500, y: 500 }) <= RULES.repairRadius)) {
        for (const ship of [...fleet.ships].sort((first, second) => first.id.localeCompare(second.id))) ship.hull = repair(ship.hull, SHIPS[ship.type].power, industrial(state) ? shipMaterials(ship.type).minerals / 1000 : SHIPS[ship.type].minerals, industrial(state) ? shipMaterials(ship.type).alloys! / 1000 : 0);
      }
    }
  }
  return capture ? factionIds(state).map(factionId => ({ factionId, ...(emergencyRules(state)?{specialSubsidy:state.factions[factionId].extraction?.last}:{}), ...(modern(state) ? { welfare: state.factions[factionId].welfare?.last, civilization: state.factions[factionId].civilization } : {}), ...(industrial(state) ? { processing: processing.filter(p => (p as {actor:string}).actor === factionId) } : {}), repairAlloys: industrial(state) ? (before[factionId].resources.alloys ?? 0) + (income[factionId].alloys ?? 0) - (state.factions[factionId].resources.alloys ?? 0) : undefined, localEconomy: balancedRules(state) ? outputs.flatMap(output => output.economicDetails).filter(detail => detail.factionId === factionId) : undefined, warExpense: balancedRules(state) ? { multiplier: previousFactors[factionId].warUpkeep, unity: previousFactors[factionId].warUnity, baseShipUpkeepPer100: warBurden(state, factionId).base, extra: { energy: warBurden(state, factionId).base.energy * ((previousFactors[factionId].warUpkeep ?? 1) - 1) * RULES.tickDays / 100, minerals: warBurden(state, factionId).base.minerals * ((previousFactors[factionId].warUpkeep ?? 1) - 1) * RULES.tickDays / 100 } } : undefined, production: income[factionId], upkeep: upkeep[factionId], before: { resources: before[factionId].resources, unity: before[factionId].unity, shortages: before[factionId].shortages }, after: { resources: state.factions[factionId].resources, unity: state.factions[factionId].unity, shortages: state.factions[factionId].shortages }, inventoryChange: Object.fromEntries(Object.entries(state.factions[factionId].resources).map(([resource, amount]) => [resource, (amount ?? 0) - (before[factionId].resources[resource as keyof Resources] ?? 0)])), repairMinerals: Math.max(0, before[factionId].resources.minerals + income[factionId].minerals - upkeep[factionId].minerals) - state.factions[factionId].resources.minerals, multipliers: { ...previousFactors[factionId], supply: supplyFactor(previousFactors[factionId].shortages), productivity: (0.5 + previousFactors[factionId].unity / 10000) * supplyFactor(previousFactors[factionId].shortages), policyEffects: previousFactors[factionId].policyEffects ?? POLICIES[previousFactors[factionId].policy?.choice ?? 'none'] }, annexations: balancedRules(state) ? state.systems.filter(system => system.ownerId === factionId && system.annexation).map(system => ({ systemId: system.id, ...system.annexation, paused: controller(system) !== factionId })) : undefined, cohesion: cohesionBreakdown(revised(state) ? { ...state, day: state.day - RULES.tickDays, factions: { ...state.factions, [factionId]: { ...state.factions[factionId], faith: previousFactors[factionId].faith, beacon: previousFactors[factionId].beacon } } } : state, factionId, previousFactors[factionId].shortages) })) : [];
}

export function economyFactors(state: GameState): Record<FactionId, FactionFactors> {
return Object.fromEntries(factionIds(state).map(factionId => {
      const faction = state.factions[factionId];
      const faith = faithEffects(faction, state.day - RULES.tickDays);
      return [factionId, { ...(governed(state) ? { parallel: true } : {}), ...(industrial(state) ? { industry: true, openingMinerals: state.factions[factionId].resources.minerals, welfareQuote: modern(state) ? welfareQuote(state, factionId, RULES.tickDays) : undefined } : {}), ...(balancedRules(state) ? { balance: true, holyScore: civilizationScore(state, factionId).main + civilizationScore(state, factionId).secondary, warUpkeep: warBurden(state, factionId).multiplier * (modern(state) ? (route(state,factionId) === 'militarist' ? CIVILIZATION.militaryMaintenance : 1) * (faction.policy?.choice === 'exercises' ? CIVILIZATION.exerciseMaintenance : 1) : 1), warUnity: warBurden(state, factionId).unity, holyProduction: holyCooperation(state, factionId) ? (modern(state) ? CIVILIZATION.holyProduction : BALANCE.holyProduction) : 1, populationGrowth: modern(state) ? (utopiaOperating(state,factionId) ? CIVILIZATION.utopiaGrowth : 1) * (faction.policy?.choice === 'exchange' && Object.values(state.relations).some(r=>r.factions.includes(factionId)&&r.status==='peace') ? CIVILIZATION.exchangeGrowth : 1) : faction.policy?.choice === 'utopia' ? BALANCE.utopiaGrowth : 1, stableFaithInterval: holyCooperation(state, factionId) && !Object.values(faction.shortages).some(Boolean) } : {}), ...(modern(state) ? { civilizationRoute: route(state,factionId), shipSpeed: route(state,factionId)==='militarist' ? CIVILIZATION.militaryShipSpeed : 1, civilizationCombat: route(state,factionId)==='militarist' ? CIVILIZATION.militaryCombat : 1, exerciseCombat: faction.policy?.choice==='exercises' ? CIVILIZATION.exerciseCombat : 1, listening: faction.policy?.choice==='listening' } : {}), unity: faction.unity, shortages: { ...faction.shortages }, policy: structuredClone(faction.policy), faith: structuredClone(faction.faith), beacon: structuredClone(faction.beacon), faithProduction: faith.production, faithCombat: faith.combat, policyEffects: currentPolicy(state, factionId) }];
    })) as Record<FactionId, FactionFactors>;
}

export function scores(state: GameState): Record<FactionId, number> {
  return factionScores(state);
}

function checkResult(state: GameState, limitReached = false) {
  const alive = factionIds(state).filter(factionId => state.systems.some(system => system.ownerId === factionId && (state.version >= 4 || system.base)));
  for (const factionId of factionIds(state)) if (!alive.includes(factionId) && state.factions[factionId].eliminatedDay === undefined) {
    state.factions[factionId].eliminatedDay = state.day;
    state.fleets = state.fleets.filter(fleet => fleet.ownerId !== factionId);
    for (const system of state.systems) system.projects = system.projects.filter(project => project.ownerId !== factionId);
    for (const relation of Object.values(state.relations)) if (relation.factions.includes(factionId)) relation.offers = {};
    for (const war of state.wars ?? []) if (war.endedDay === undefined && war.factions.includes(factionId)) settleWar(state, war, false, `${state.factions[factionId].name}淘汰`);
    diplomacyEvent(state, `${state.factions[factionId].name}失去全部基地，已淘汰`, factionIds(state));
  }
  if (alive.length > 1 && !limitReached) return;
  const tally = scores(state);
  const best = Math.max(...alive.map(id => tally[id]));
  const leaders = alive.filter(id => tally[id] === best);
  const winner = leaders.length === 1 ? leaders[0] : null;
  state.result = { winner, reason: alive.length <= 1 ? 'elimination' : 'score', scores: tally };
  appendEvents(state, [{ day: state.day, type: 'game', text: `比赛结束：${winner ? state.factions[winner].name + '获胜' : '平局'}`, systemId: null, audience: factionIds(state) }]);
}

export interface SimulationBatch { day: number; events: GameState['events']; movements: unknown[]; economy: unknown[] }
export type SimulationSink = (batch: SimulationBatch) => Promise<void>;

export async function advanceRound(original: GameState, pool: SimulationPool, actions: Record<FactionId, Action[]> = {}, sink?: SimulationSink): Promise<GameState> {
  if (original.result) throw new Error('比赛已经结束');
  const state = commitActions(original, actions);
  updatePolicies(state);
  updateDiplomacy(state);
  for (const factionId of factionIds(state)) state.factions[factionId].lastIncome = resources();
  let eventCursor = original.events.length;
  if (sink) await sink({ day: state.day, events: state.events.slice(eventCursor), movements: [], economy: [] });
  eventCursor = state.events.length;
  for (let tick = 0; tick < RULES.daysPerRound / RULES.tickDays; tick++) {
    const beforeFleets = sink ? structuredClone(state.fleets) : [];
    const openingMinerals = factionRecord(factionIds(state), id => state.factions[id].resources.minerals);
    let openingValue: Record<string, number> = {};
    let economy: unknown[] = [];
    const controlled = Object.fromEntries(state.systems.map(system => [system.id, controller(system)]));
    freezeOperations(state);
    state.day += RULES.tickDays;
    updateEscalation(state);
    arrive(state);
    updateContacts(state);
    updateDiplomacy(state);
    updatePursuit(state);
    const factions = economyFactors(state);
    for (const phase of ['advance', 'combat', 'economy'] as const) {
      if(phase==='economy' && modern(state)) for(const id of factionIds(state)) factions[id].welfareQuote=welfareQuote(state,id,RULES.tickDays);
      if (phase === 'combat') openingValue = Object.fromEntries(factionIds(state).map(id => [id, fleetValue(state, id)]));
      const fleets = state.fleets.filter(fleet => fleet.systemId || phase === 'combat' && fleet.departedDay === state.day);
      const outputs = await pool.execute({ phase, day: state.day, systems: state.systems, fleets, factions, seed: state.config.seed, relations: state.relations, wars: state.version >= 4 ? state.wars ?? [] : undefined });
      mergePhase(state, phase, outputs);
      if (phase === 'advance') updateContacts(state);
      if (phase === 'combat') {
        for (const war of state.wars ?? []) if (war.startedDay === state.day) for (const id of war.factions) war.openingValue[id] = Math.max(180, openingValue[id]);
        accountBattleLosses(state, outputs.flatMap(output => output.events), openingValue);
        updateWars(state);
        updateDiplomacy(state);
      }
      if (phase === 'economy') economy = settleEconomy(state, outputs, factions, !!sink);
    }
    if (!emergencyRules(state)) recordGovernance(state);
    if (governed(state)) for (const row of economy as {factionId:string;governance?:unknown;construction?:unknown}[]) { row.governance = state.factions[row.factionId].governance?.at(-1); row.construction = state.systems.flatMap(s=>s.projects.filter(p=>p.ownerId===row.factionId).map(p=>({id:p.id,kind:p.kind,createdDay:p.createdDay,progress:p.progress,systemId:s.id}))); }
    updateSocial(state);
    trackCivilization(state, Object.fromEntries(Object.entries(factions).map(([id,f])=>[id,f.unity])));
    updateFaith(state);
    applyExtractionRecovery(state);
    if (emergencyRules(state)) { recordGovernance(state); for(const row of economy as {factionId:string;governance?:unknown;extraction?:unknown}[]) { row.governance=state.factions[row.factionId].governance?.at(-1); row.extraction=state.factions[row.factionId].extraction?.last; } }
    trackBeacon(state, factions);
    finishBalanceInterval(state, factions, controlled);
    restoreBases(state);
    updatePolicies(state);
    refreshIntel(state);
    checkResult(state);
    updateEscalation(state, 0);
    if (sink) await sink({ day: state.day, events: state.events.slice(eventCursor), economy, movements: state.fleets.flatMap(fleet => {
      const previous = beforeFleets.find(candidate => candidate.id === fleet.id);
      const location = (value: Fleet) => ({ systemId: value.systemId, position: value.position, transit: value.transit, withdrawal: value.withdrawal });
      return !previous || JSON.stringify(location(previous)) !== JSON.stringify(location(fleet)) ? [{ fleetId: fleet.id, factionId: fleet.ownerId, before: previous ? location(previous) : null, after: location(fleet) }] : [];
    }) });
    eventCursor = state.events.length;
    if (state.result) break;
  }
  if (!state.result) checkResult(state, state.round + 1 >= state.config.maxRounds);
  if (sink && state.events.length > eventCursor) await sink({ day: state.day, events: state.events.slice(eventCursor), movements: [], economy: [] });
  state.round++;
  state.events = state.events.slice(-1500);
  return state;
}
