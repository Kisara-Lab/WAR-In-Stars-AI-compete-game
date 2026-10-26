import { modernRules, responsible } from './responsibility.js';
import { RULES, SHIPS } from './rules.js';
import type { GameState, StarSystem } from './types.js';
import { controller, occupied } from './v4.js';

export const BALANCE = {
  revision: '4.2', offensiveUpkeep: 0.25, defensiveUpkeep: 0.10, upkeepCap: 0.60,
  offensiveUnity: 1, offensiveUnityCap: 3, annexationDays: 720, annexationFactor: 0.5, annexationUnity: -2,
  utopiaProduction: [0.85, 0.90, 0.95], utopiaGrowth: 1.25, holyProduction: 1.05,
  stableCrisis: 20, qualifiedSupply: 0.9, termScore: 100, mainScore: 200, secondaryScore: 100, secondaryCap: 2, civilizationCap: 1500,
} as const;
export const balancedRules = (state: Pick<GameState, 'rulesRevision'>) => (state.rulesRevision === BALANCE.revision || state.rulesRevision === '4.3' || modernRules(state));
export const integrating = (system: StarSystem) => !!system.annexation && system.annexation.ownerId === system.ownerId && system.annexation.controlledDays < BALANCE.annexationDays;
export const annexationFactor = (system: StarSystem, day = Infinity) => integrating(system) && system.annexation!.startedDay <= day && !occupied(system) ? BALANCE.annexationFactor : 1;
export function warBurden(state: GameState, actor: string) {
  const wars = balancedRules(state) ? (state.wars ?? []).filter(war => war.type === 'total' && war.endedDay === undefined && war.factions.includes(actor)) : [];
  const offensive = wars.filter(war => (war.totalAttackers ?? war.attackers).includes(actor)).length;
  const defensive = wars.length - offensive;
  const multiplier = 1 + Math.min(BALANCE.upkeepCap, offensive * BALANCE.offensiveUpkeep + defensive * BALANCE.defensiveUpkeep);
  const base = state.fleets.filter(fleet => fleet.ownerId === actor).flatMap(fleet => fleet.ships).reduce((sum, ship) => ({ energy: sum.energy + SHIPS[ship.type].energy, minerals: sum.minerals + SHIPS[ship.type].upkeep }), { energy: 0, minerals: 0 });
  return { offensive, defensive, multiplier, unity: -Math.min(BALANCE.offensiveUnityCap, offensive * BALANCE.offensiveUnity), base, extra: { energy: base.energy * (multiplier - 1), minerals: base.minerals * (multiplier - 1) } };
}
export function heldHolySites(state: GameState, actor: string) {
  return (state.factions[actor].faith?.sites ?? []).filter(site => site.consecratedDay !== undefined && state.systems.some(system => system.ownerId === actor && controller(system) === actor && system.planets.some(planet => planet.id === site.planetId && planet.ownerId === actor)));
}
export function holyCooperation(state: GameState, actor: string) {
  return balancedRules(state) && !!state.factions[actor].faith && state.factions[actor].faith!.crisis < BALANCE.stableCrisis && heldHolySites(state, actor).some(site => site.main);
}
export function civilizationScore(state: GameState, actor: string) {
  const awards = balancedRules(state) ? (state.civilizationAwards ?? []).filter(award => award.actor === actor) : [];
  const utopia = new Set(awards.filter(award => award.category === 'utopia').map(award => award.term)).size * BALANCE.termScore;
  const faith = new Set(awards.filter(award => award.category === 'faith').map(award => award.term)).size * BALANCE.termScore;
  const held = balancedRules(state) ? heldHolySites(state, actor) : [];
  const main = Number(held.some(site => site.main)) * BALANCE.mainScore;
  const secondary = Math.min(BALANCE.secondaryCap, held.filter(site => !site.main).length) * BALANCE.secondaryScore;
  const sites = balancedRules(state) ? state.factions[actor].faith?.sites.filter(site => site.consecratedDay !== undefined) ?? [] : [];
  const unavailableHoly = Number(sites.some(site => site.main) && !main) * BALANCE.mainScore + (Math.min(BALANCE.secondaryCap, sites.filter(site => !site.main).length) * BALANCE.secondaryScore - secondary);
  return { utopia, faith, main, secondary, unavailableHoly, cap: BALANCE.civilizationCap, ...(responsible(state)?{responsibilityPenalty:state.factions[actor].responsibility?.rescuePenalty??0}:{}), total: Math.max(0,Math.min(BALANCE.civilizationCap, utopia + faith + main + secondary)-(responsible(state)?state.factions[actor].responsibility?.rescuePenalty??0:0)) };
}
export const firstCompleteTerm = (state: GameState) => Math.ceil((state.balanceStartedDay ?? 0) / RULES.policyDays);
