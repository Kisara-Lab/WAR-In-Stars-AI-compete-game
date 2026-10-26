import { sensorCoverage } from './civil.js';
import { controller } from './v4.js';
import type { GameState, Fleet } from './types.js';

export function viewpoint(original: GameState, viewer: string): GameState {
  if (!viewer || !original.factions[viewer]) return original;
  const state = structuredClone(original);
  const faction = original.factions[viewer];
  const local = new Set(original.systems.filter(system => controller(system) === viewer).map(system => system.id));
  for (const fleet of original.fleets) if (fleet.ownerId === viewer && fleet.systemId) local.add(fleet.systemId);
  const military = new Set([...local, ...sensorCoverage(original, viewer)]);
  const fleets = new Map<string, Fleet>();
  const sanitizeFleet = (fleet: Fleet) => fleet.ownerId === viewer ? fleet : { ...fleet, order: null, withdrawal: undefined };
  state.systems = original.systems.map(system => {
    const memory = faction.intel[system.id]?.system;
    const militaryMemory = faction.militaryIntel?.[system.id];
    const known = local.has(system.id) ? system : memory;
    const militaryKnown = military.has(system.id) ? system : militaryMemory ?? memory;
    const seenFleets = military.has(system.id) ? original.fleets.filter(fleet => fleet.systemId === system.id) : militaryMemory?.fleets ?? faction.intel[system.id]?.fleets ?? [];
    for (const fleet of seenFleets) fleets.set(fleet.id, sanitizeFleet(structuredClone(fleet)));
    const planets = faction.surveyed.includes(system.id) ? known?.planets ?? system.planets.map(planet => ({ ...planet, structures: [], influence: undefined, ownerId: null, population: 0, growthDays: 0 })) : [];
    return { ...system, ownerId: militaryKnown?.ownerId ?? null, controllerId: militaryKnown ? controller(militaryKnown) : null, base: militaryKnown?.base ?? null, planets: structuredClone(planets).map(planet => ({ ...planet, influence: planet.ownerId === viewer ? planet.influence : undefined })), projects: system.projects.filter(project => project.ownerId === viewer), occupationWarId: known?.occupationWarId, annexation: system.ownerId === viewer ? system.annexation : known?.annexation, integrationUntil: system.ownerId === viewer ? system.integrationUntil : undefined, missionProtectionUntil: known?.missionProtectionUntil };
  });
  for (const fleet of original.fleets.filter(fleet => fleet.ownerId === viewer)) fleets.set(fleet.id, structuredClone(fleet));
  for (const intel of Object.values(faction.transitIntel ?? {})) if (!fleets.has(intel.fleet.id)) fleets.set(intel.fleet.id, sanitizeFleet(structuredClone(intel.fleet)));
  state.fleets = [...fleets.values()];
  for (const other of Object.values(state.factions)) if (other.id !== viewer) {
    const extraction=other.extraction;
    other.extraction=extraction?.known[viewer]!==undefined ? {...extraction,ships:{},initialCrisis:0,initialUnity:0,totalGrant:{energy:0,minerals:0,food:0},last:undefined,known:{[viewer]:extraction.known[viewer]},demands:extraction.demands.filter(d=>d.actor===viewer),responses:{},qualifiedDays:0} : undefined;
    other.resources = { energy: 0, food: 0, minerals: 0 }; other.lastIncome = { energy: 0, food: 0, minerals: 0 }; other.unity = 0;
    other.governance = undefined; other.annexationProgress = undefined; other.responsibility = undefined; other.failedOrders = undefined; other.welfare = undefined; other.civilization = undefined; other.stableFaith = undefined; other.faith = undefined; other.beacon = undefined; other.policy = undefined; other.intel = {}; other.militaryIntel = {}; other.transitIntel = {}; other.strategies = []; other.surveyed = [];
  }
  state.relations = Object.fromEntries(Object.entries(state.relations).filter(([, relation]) => relation.factions.includes(viewer)));
  if (state.rivalries) state.rivalries = Object.fromEntries(Object.entries(state.rivalries).filter(([, item]) => item.factions.includes(viewer)));
  if (state.conquests) state.conquests = state.conquests.filter(item => item.actor === viewer || item.target === viewer);
  if (state.warAchievements) state.warAchievements = state.warAchievements.filter(item => item.actor === viewer);
  if (state.civilizationAwards) state.civilizationAwards = state.civilizationAwards.filter(award => award.actor === viewer);
  state.wars = state.wars?.filter(war => war.factions.includes(viewer));
  state.claims = state.claims?.filter(claim => claim.factionId === viewer);
  state.grievances = state.grievances?.filter(grievance => grievance.actor === viewer);
  state.missions = state.missions?.filter(mission => mission.hostId === viewer || mission.religionId === viewer);
  state.events = state.events.filter(event => event.audience.includes(viewer));
  return state;
}
