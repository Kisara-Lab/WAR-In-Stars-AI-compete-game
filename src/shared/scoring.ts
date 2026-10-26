import { industrial, reserveScore } from './industry.js';
import { governed, governanceView } from './governance.js';
import { balancedRules, civilizationScore, integrating } from './balance.js';
import { ESCALATION, revised } from './escalation.js';
import { factionIds, factionRecord, SHIPS } from './rules.js';
import type { GameState } from './types.js';

export function scoreBreakdown(state: GameState, id: string) {
    const systems = state.systems.filter(system => system.ownerId === id);
    const colonies = systems.flatMap(system => system.planets).filter(planet => planet.ownerId === id);
    const population = colonies.reduce((sum, planet) => sum + planet.population, 0);
    const quality = governed(state) ? governanceView(state, id).quality : 1;
    const basePower = state.fleets.filter(fleet => fleet.ownerId === id).flatMap(fleet => fleet.ships).reduce((sum, ship) => sum + SHIPS[ship.type].power, 0);
    const achievements = revised(state) ? (state.warAchievements ?? []).filter(item => item.actor === id) : [];
    const territory = new Set(achievements.filter(item => item.type === 'territory' && systems.some(system => system.id === item.systemId && (!balancedRules(state) || !integrating(system)))).map(item => item.systemId)).size * ESCALATION.territoryScore;
    const objectives = Math.min(ESCALATION.objectiveScoreCap, new Set(achievements.filter(item => item.type !== 'territory').map(item => JSON.stringify([item.target, item.systemId, item.type]))).size * ESCALATION.objectiveScore);
    const parts = { ...(balancedRules(state) ? { civilization: civilizationScore(state, id).total } : {}), systems: systems.length * 100, colonies: colonies.length * 200 * quality, population: population * 5 * quality, fleet: basePower * (revised(state) ? ESCALATION.fleetScoreFactor : 1), ...(industrial(state) ? { reserves: reserveScore(state.factions[id].resources) } : { minerals: state.factions[id].resources.minerals / 10000 }), territory, objectives };
    return { ...parts, total: Math.round(Object.values(parts).reduce((sum, value) => sum + value, 0) * 1000) / 1000 };
}
export function factionScores(state: GameState): Record<string, number> {
  return factionRecord(factionIds(state), id => scoreBreakdown(state, id).total);
}
