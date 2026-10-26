import { CIVILIZATION, WELFARE, V5_POLICIES, modern, route, utopiaOperating } from './civilization.js';
import { INDUSTRY, industrial, operating, rates } from './industry.js';
import { BALANCE, balancedRules, integrating, warBurden } from './balance.js';
import { conquestFor, ESCALATION } from './escalation.js';
import { RULES } from './rules.js';
import type { GameState, Planet, Shortages } from './types.js';
import { V4, faithEffects, foreignInfluence, occupied } from './v4.js';
import { responsible, militaryDiscontent } from './responsibility.js';

export const POLICIES = {
  ...V5_POLICIES,
  none: { name: '不采用政策', energy: 1, minerals: 1, food: 1, unity: 0, combat: 1, penalty: 1 },
  militarism: { name: '穷兵黩武', energy: 1.25, minerals: 1.35, food: 0.65, unity: -4, combat: 1.1, penalty: 1.5 },
  utopia: { name: '乌托邦', energy: 0.75, minerals: 0.75, food: 1, unity: 8, combat: 1, penalty: 1 },
  balanced: { name: '均衡发展', energy: 0.95, minerals: 0.95, food: 1.1, unity: 2, combat: 1, penalty: 1 },
} as const;
export type PolicyId = keyof typeof POLICIES;
export interface PolicyState { term: number; choice: PolicyId; explicit: boolean; locked: boolean; next?: { term: number; choice: PolicyId } }
export const supplyFactor = (shortages: Shortages) => 0.5 ** Object.values(shortages).filter(Boolean).length;
export const currentPolicy = (state: GameState, factionId: string) => {
  const faction = state.factions[factionId];
  const policy = POLICIES[faction.policy?.choice ?? 'none'];
  if (modern(state)) { const peaceful = Object.values(state.relations).some(r => r.factions.includes(factionId) && r.status === 'peace'); return { ...(V5_POLICIES[faction.policy?.choice as keyof typeof V5_POLICIES] ?? V5_POLICIES.none), unity: faction.policy?.choice === 'exchange' && peaceful ? CIVILIZATION.exchangeUnity : 0, penalty: route(state, factionId) === 'militarist' ? CIVILIZATION.militaryIndustryPenalty : 1 }; }
  const streak = faction.policy?.choice === 'utopia' && !faction.faith ? faction.beacon?.streak ?? 0 : 0;
  if (balancedRules(state) && faction.policy?.choice === 'utopia') {
    const level = streak >= 3 ? 2 : streak >= 2 ? 1 : 0;
    return { ...policy, energy: BALANCE.utopiaProduction[level], minerals: BALANCE.utopiaProduction[level] };
  }
  return { ...policy, energy: streak >= 3 ? V4.beaconProduction : policy.energy, minerals: streak >= 3 ? V4.beaconProduction : policy.minerals };
};
export function policyWindow(state: GameState, factionId: string): number | null {
  const policy = state.factions[factionId].policy;
  const term = Math.floor(state.day / RULES.policyDays);
  if (state.day === 0 && !policy?.locked) return 0;
  if (state.day < (term + 1) * RULES.policyDays && state.day + RULES.daysPerRound >= (term + 1) * RULES.policyDays && !policy?.next) return term + 1;
  return null;
}
export function planetCohesion(planet: Planet, day?: number) {
  const count = (type: string) => day === undefined ? planet.structures.filter(structure => structure.type === type).length : operating(planet, type as import('./rules.js').StructureType, day);
  const mines = count('mine');
  return { planetId: planet.id, population: planet.population, mines, positive: count('sanatorium') * RULES.sanatoriumUnity + count('resort') * RULES.resortUnity, mining: -Math.max(0, mines - RULES.freeMines) * RULES.miningUnityPenalty - (day === undefined ? 0 : count('foundry') * INDUSTRY.foundryUnity) };
}
export function cohesionBreakdown(state: GameState, factionId: string, shortages = state.factions[factionId].shortages) {
  const policy = currentPolicy(state, factionId);
  const planets = state.systems.flatMap(system => system.planets.filter(planet => planet.ownerId === factionId && planet.population > 0).map(planet => ({ ...planetCohesion(planet, industrial(state) ? state.day : undefined), occupied: occupied(system), integrating: balancedRules(state) && integrating(system) && system.annexation!.startedDay <= state.day })));
  const population = planets.reduce((total, planet) => total + planet.population, 0);
  const factor = supplyFactor(shortages);
  const contributions = planets.map(planet => ({ ...planet, weight: population ? planet.population / population : 0, contribution: population ? (planet.occupied ? V4.occupationUnity : planet.integrating ? BALANCE.annexationUnity : planet.positive * factor + planet.mining * policy.penalty) * planet.population / population : 0 }));
  const base = Object.values(shortages).some(Boolean) ? 0 : RULES.suppliedUnity;
  const shortage = -(Number(shortages.food) * RULES.foodUnityPenalty + Number(shortages.energy) * RULES.energyUnityPenalty + Number(shortages.minerals) * RULES.maintenanceUnityPenalty) * (modern(state) ? 1 : policy.penalty);
  const policyUnity = policy.unity > 0 ? policy.unity * factor : policy.unity;
  const buildings = contributions.reduce((total, planet) => total + planet.contribution, 0);
  const faithUnity = faithEffects(state.factions[factionId], state.day).unity;
  const religion = faithUnity > 0 ? faithUnity * factor : faithUnity;
  const foreign = state.factions[factionId].faith ? 0 : -V4.foreignPenalty * foreignInfluence(state, factionId);
  const streak = (modern(state) ? utopiaOperating(state, factionId) : state.factions[factionId].policy?.choice === 'utopia') ? state.factions[factionId].beacon?.streak ?? 0 : 0;
  const beacon = responsible(state)&&state.factions[factionId].responsibility?.ignored ? 0 : Math.min(2, Math.max(0, streak - 1)) * factor;
  const preparation = conquestFor(state, factionId);
  const conquest = preparation && preparation.readyDay > state.day ? ESCALATION.preparationUnityPer100 : 0;
  const war = warBurden(state, factionId).unity;
  const welfareState = state.factions[factionId].welfare;
  const fulfillment = welfareState?.last?.fraction ?? 1;
  const welfareRule = WELFARE[welfareState?.choice ?? 'comfortable'];
  const welfare = modern(state) ? (welfareRule.unity > 0 ? welfareRule.unity * fulfillment * factor : welfareRule.unity) - CIVILIZATION.brokenPromise * (1 - fulfillment) : 0;
  const civilization = modern(state) && utopiaOperating(state, factionId) ? CIVILIZATION.utopiaUnity * factor : 0;
  const military=route(state,factionId)==='militarist'?militaryDiscontent(state,factionId):0;
  return { ...(responsible(state)?{military}:{}), ...(modern(state) ? { welfare, civilization } : {}), ...(balancedRules(state) ? { war } : {}), base, shortage, policy: policyUnity, buildings, religion, foreign, beacon, ...(state.rulesRevision ? { conquest } : {}), total: base + shortage + policyUnity + buildings + religion + foreign + beacon + conquest + war + welfare + civilization + military, factor, planets: contributions };
}
export function sensorCoverage(state: GameState, factionId: string): Set<string> {
  const result = new Set<string>();
  const faction = state.factions[factionId];
  if (!faction || faction.shortages.energy || faction.shortages.minerals) return result;
  let frontier = state.systems.filter(system => system.ownerId === factionId && !occupied(system) && system.planets.some(planet => planet.ownerId === factionId && planet.structures.some(structure => structure.type === 'lrs' && (!industrial(state) || (rates(planet, state.day)[structure.id] ?? 0) === 1)))).map(system => system.id);
  for (let hop = 0; hop <= RULES.sensorHops; hop++) {
    const next: string[] = [];
    for (const id of frontier) if (!result.has(id)) { result.add(id); next.push(...(state.systems.find(system => system.id === id)?.neighbors ?? [])); }
    frontier = next;
  }
  return result;
}
