import { responsible } from '../shared/responsibility.js';
import { modernRules, decisionBalanced } from '../shared/responsibility.js';
import { initializeSocial } from './social.js';
import { initializeCivilization } from '../shared/civilization.js';
import { INDUSTRY, TRAITS } from '../shared/industry.js';
import { randomGenerator } from './math.js';
import { randomUUID } from 'node:crypto';
import { BASE, DEFAULT_CONFIG, FACTION_PRESETS, RULES, SHIPS, units } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Faction, GameState, MatchConfig } from '../shared/types.js';
import { generateGalaxy } from './galaxy.js';
import { createRelations } from './diplomacy.js';
import { refreshIntel } from './intel.js';


function makeFaction(id: FactionId, homeSystemId: string): Faction {
  return {
    ...FACTION_PRESETS.find(preset => preset.id === id)!,
    id, homeSystemId,
    resources: { energy: units(RULES.startingEnergy), food: units(RULES.startingFood), minerals: units(RULES.startingMinerals), alloys: units(INDUSTRY.startingAlloys) },
    lastIncome: { energy: 0, food: 0, minerals: 0, alloys: 0 },
    unity: RULES.startingUnity,
    shortages: { energy: false, food: false, minerals: false },
    policy: { term: 0, choice: 'none', explicit: false, locked: false }, militaryIntel: {}, transitIntel: {},
    beacon: { term: 0, totalDays: 0, suppliedDays: 0, disqualified: false, streak: 0, highest: 0 },
    surveyed: [homeSystemId], intel: {}, strategies: [],
  };
}

export function createGame(config: MatchConfig = structuredClone(DEFAULT_CONFIG), id: string = randomUUID(), revision: '4.2' | '4.3' | '5.0' | '5.1' | '5.2' | '5.3' | '5.4' = '5.4'): GameState {
  const count = config.factionIds.length;
  if (count < 4 || count > 8 || new Set(config.factionIds).size !== count || config.factionIds.some(id => !FACTION_PRESETS.some(preset => preset.id === id))) throw new Error('新比赛需要 4～8 个不同势力');
  if (!Number.isInteger(config.systemCount) || config.systemCount < count * 6 || config.systemCount > 512 || config.systemCount % count) throw new Error('星系数必须为势力数的整数倍，每方至少六个星系，最多512个');
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 1000) throw new Error('轮数须为1～1000');
  const systems = generateGalaxy(config, decisionBalanced({rulesRevision:revision}),responsible({rulesRevision:revision}));
  const factions = Object.fromEntries(config.factionIds.map((id, index) => [id, makeFaction(id, systems[index * config.systemCount / count].id)]));
  const state: GameState = { version: modernRules({rulesRevision:revision}) ? 5 : 4, rulesRevision: revision, balanceStartedDay: 0, civilizationAwards: [], revisionStartedDay: 0, rivalries: {}, conquests: [], warAchievements: [], wars: [], claims: [], grievances: [], missions: [], cessions: [], relations: createRelations(config.factionIds), id, config: structuredClone(config), round: 0, day: 0, systems, fleets: [], factions, events: [], result: null };
  for (const factionId of config.factionIds) {
    const home = systems.find(system => system.id === factions[factionId].homeSystemId)!;
    home.ownerId = factionId;
    home.base = { hull: BASE.power };
    const planet = home.planets[0];
    planet.ownerId = factionId;
    planet.population = RULES.startingPopulation;
    planet.structures = (['mine', 'mine', 'farm', 'solar', 'shipyard', 'foundry'] as const).map((type, index) => ({ id: `${planet.id}-initial-${index}`, type }));
    state.fleets.push({ id: `${factionId}-initial`, name: `${factions[factionId].name}第一舰队`, ownerId: factionId, systemId: home.id, position: { ...planet.position }, transit: null, order: null, ships: Array.from({ length: 3 }, (_, index) => ({ id: `${factionId}-initial-${index}`, type: 'destroyer', hull: SHIPS.destroyer.power })) });
  }
  for (let i = 0; i < systems.length; i++) for (let p = 0; p < systems[i].planets.length; p++) {
    const local = i % (config.systemCount / count);
    systems[i].planets[p].trait = local === 0 ? 'ordinary' : TRAITS[Math.floor(randomGenerator(config.seed + ':trait:' + local + ':' + p)() * TRAITS.length)];
  }
  if (revision === '4.2') {
    for (const faction of Object.values(factions)) { delete faction.resources.alloys; delete faction.lastIncome.alloys; }
    for (const system of systems) for (const planet of system.planets) { delete planet.trait; planet.structures = planet.structures.filter(s => s.type !== 'foundry'); }
  }
  if (modernRules({rulesRevision:revision})) for (const actor of config.factionIds) initializeCivilization(state, actor);
  if(responsible({rulesRevision:revision})) initializeSocial(state);
  refreshIntel(state);
  return state;
}
