import type { Faction, GameState, StarSystem } from './types.js';
import { SHIPS } from './rules.js';

export const V4 = {
  claimCost: 100, claimDays: 1800, maxClaims: 2, holdDays: 200, warDays: 2160, contactDays: 900,
  occupationProduction: 0.25, occupationUnity: -2, disabledDays: 300, ruinDays: 100, reparations: 200,
  fatigueTime: 3, fatigueOccupation: 4, fatigueLoss: 40, fatigueLossCap: 40, militaryFloor: 180,
  grievanceDays: 1080, attackedGrievanceDays: 2160,
  consecrateMinerals: 200, consecrateFood: 100, consecrateDays: 300, secondarySites: 2,
  crisisLoss: 40, crisisLossCap: 30, mainLoss: 30, secondaryLoss: 15, mainPressure: 4, secondaryPressure: 2,
  mainRecovery: 15, secondaryRecovery: 7, warFailure: 10, missionVictory: 8, peaceRecovery: 2, warRecovery: 1,
  mainBlessing: 5, secondaryBlessing: 2, disputePressure: 2, disputeResetDays: 300,
  reconciliationMinerals: 100, reconciliationFood: 200, responseDays: 300, responseCooldown: 720,
  reconciliationRecovery: 4, reformRecovery: 6, zealCombat: 1.05, vowSuccess: 5, vowFailure: 15,
  missionDays: 1800, missionInitial: 20, missionGrowth: 5, missionDecay: 2, foreignPenalty: 4,
  protectionDays: 1080, integrationMinerals: 100, integrationFood: 100, integrationDays: 720, integrationRate: 3,
  beaconSupply: 0.9, beaconProduction: 0.8,
  faithTiers: [
    { minimum: 0, unity: 4, production: 1, combat: 1.08 },
    { minimum: 20, unity: 1, production: 0.95, combat: 1 },
    { minimum: 40, unity: -4, production: 0.85, combat: 0.9 },
    { minimum: 70, unity: -8, production: 0.7, combat: 0.75 },
  ],
} as const;
export type WarType = 'total' | 'limited' | 'claim' | 'missionary' | 'ideological' | 'contact' | 'humanitarian';
export const WAR_NAMES: Record<WarType, string> = { total: '总体战', limited: '有限军事战', claim: '宣称夺取战', missionary: '传教战', ideological: '保卫思潮', contact: '首次接触边境冲突', humanitarian: '民生救援战' };
export interface WarGoal { type: Exclude<WarType, 'total' | 'contact'>; systemId: string; heldDays: number; heldSince?: number; invalid?: boolean; achieved?: boolean }
export interface War {
  openingTerritories?: Record<string,string[]>;
  humanitarianReasons?: Record<string,string>;
  id: string; factions: [string, string]; type: WarType; startedDay: number; startedRound: number;
  hadHostilities?: boolean;
  legacy?: boolean; endedDay?: number; outcome?: string;
  totalAttackers?: string[];
  attackers: string[]; reasons: Record<string, string>; goals: Record<string, WarGoal[]>;
  fatigue: Record<string, number>; openingValue: Record<string, number>;
  lossWindow: number; lossUsed: Record<string, number>;
}
export interface Claim { factionId: string; targetId: string; systemId: string; createdRound: number; expiresDay: number }
export interface Grievance { id: string; actor: string; target: string; kind: 'home' | 'territory' | 'holy' | 'attacked' | 'rivalry' | 'conquest'; active: boolean; expiresDay: number; source: string }
export interface Mission { id: string; warId: string; religionId: string; hostId: string; systemId: string; startsDay: number; expiresDay: number }
export interface HolySite { planetId: string; main: boolean; consecratedDay?: number; lostSince?: number; lossKeys: string[]; recoveryKeys: string[]; lossKey?: string }
export interface Faith {
  name: string; doctrine: string; establishedDay: number; crisis: number; sites: HolySite[];
  lossWindow: number; lossUsed: number; pending: { reason: string; amount: number; source?: string }[];
  triggers: Record<string, { days: number; clearDays: number; armed: boolean }>;
  dispute?: { id: string; cause: string; openedDay: number };
  response?: { type: 'reconcile' | 'reform' | 'zeal'; startsDay: number; effectUntil: number; cooldownUntil: number; vow?: { planetId?: string; warId?: string; systemId?: string; deadline: number; resolved: boolean } };
  lastChanges?: { reason: string; amount: number; source?: string }[];
}
export interface Beacon { term: number; totalDays: number; suppliedDays: number; disqualified: boolean; streak: number; highest: number }
export const controller = (system: Pick<StarSystem, 'ownerId' | 'controllerId'>) => system.controllerId === undefined ? system.ownerId : system.controllerId;
export const occupied = (system: StarSystem) => controller(system) !== system.ownerId;
export const operational = (system: StarSystem, day: number) => !!system.base && (!system.base.disabledUntil || system.base.disabledUntil <= day);
export const activeWar = (state: GameState, first: string, second: string) => state.wars?.find(war => war.endedDay === undefined && war.factions.includes(first) && war.factions.includes(second));
export const warView = (war: War, actor: string) => ({ ...war, ...(war.openingTerritories?{openingTerritories:{[actor]:war.openingTerritories[actor]}}:{}), openingValue: { [actor]: war.openingValue[actor] }, lossUsed: { [actor]: war.lossUsed[actor] } });
export const fleetValue = (state: GameState, factionId: string) => state.fleets.filter(fleet => fleet.ownerId === factionId).reduce((total, fleet) => total + fleet.ships.reduce((value, ship) => value + SHIPS[ship.type].minerals * ship.hull / SHIPS[ship.type].power, 0), 0);
export function faithEffects(faction: Pick<Faction, 'faith'>, day: number) {
  if (!faction.faith) return { unity: 0, production: 1, combat: 1 };
  const faith = faction.faith;
  const tier = [...V4.faithTiers].reverse().find(candidate => faith.crisis >= candidate.minimum)!;
  const response = faith.response;
  const reform = response?.type === 'reform' && response.cooldownUntil > day;
  return { unity: reform ? Math.min(0, tier.unity) : tier.unity, production: tier.production, combat: (reform ? Math.min(1, tier.combat) : tier.combat) * (response?.type === 'zeal' && response.effectUntil > day ? V4.zealCombat : 1) };
}
export function foreignInfluence(state: GameState, factionId: string) {
  let population = 0;
  let affected = 0;
  for (const system of state.systems) for (const planet of system.planets) if (planet.ownerId === factionId && planet.population) {
    population += planet.population;
    if (!occupied(system)) affected += planet.population * Object.entries(planet.influence ?? {}).filter(([id]) => id !== factionId).reduce((sum, [, value]) => sum + value, 0) / 100;
  }
  return population ? affected / population : 0;
}
export function v4Event(state: GameState, type: 'war' | 'religion' | 'beacon' | 'economy', text: string, audience: string[], details: unknown = {}, systemId: string | null = null) {
  const prefix = `${state.day}-${type}-`;
  const sequence = 1 + Math.max(-1, ...state.events.filter(event => event.id.startsWith(prefix) && /^\d+$/.test(event.id.slice(prefix.length))).map(event => Number(event.id.slice(prefix.length))));
  state.events.push({ id: `${prefix}${sequence}`, round: state.round + 1, day: state.day, type, text, audience: [...new Set(audience)].sort(), systemId, details: structuredClone(details) });
}
export const roundValue = (value: number) => Math.round(value * 1000) / 1000;

export function observeHolyControl(state: GameState, system: StarSystem, source?: string) {
  const host = controller(system);
  for (const [actor, faction] of Object.entries(state.factions)) {
    const faith = faction.faith;
    if (!faith) continue;
    for (const site of faith.sites.filter(site => site.consecratedDay !== undefined && system.planets.some(planet => planet.id === site.planetId))) {
      if (host !== actor && site.lostSince === undefined) {
        site.lostSince = state.day;
        site.lossKey = source ?? (host ? activeWar(state, actor, host)?.id : undefined) ?? `sovereignty-${state.day}-${system.id}`;
        if (!site.lossKeys.includes(site.lossKey)) {
          site.lossKeys.push(site.lossKey);
          faith.pending.push({ reason: site.main ? '主圣地失守' : '附属圣地失守', amount: site.main ? V4.mainLoss : V4.secondaryLoss, source: site.lossKey });
        }
        v4Event(state, 'religion', `${faith.name}${site.main ? '主' : '附属'}圣地失守`, [actor, host].filter((id): id is string => !!id), { planetId: site.planetId, controllerId: host, lossKey: site.lossKey }, system.id);
      } else if (host === actor && site.lostSince !== undefined) {
        if (site.lossKey && !site.recoveryKeys.includes(site.lossKey)) {
          site.recoveryKeys.push(site.lossKey);
          faith.pending.push({ reason: '圣地收复', amount: -(site.main ? V4.mainRecovery : V4.secondaryRecovery), source: site.lossKey });
        }
        delete site.lostSince;
        v4Event(state, 'religion', `${faith.name}收复圣地`, [actor], { planetId: site.planetId, lossKey: site.lossKey }, system.id);
      }
    }
  }
}
