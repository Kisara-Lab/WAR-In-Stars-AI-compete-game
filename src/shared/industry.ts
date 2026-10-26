import { modernRules } from './responsibility.js';
import { RULES, SHIPS, STRUCTURES, units, type StructureType, type ShipType } from './rules.js';
import type { GameState, Planet, Resources, Structure } from './types.js';

export const INDUSTRY = { revision: '4.3', startingAlloys: 100, restartDays: 100, idleMaintenance: .2, sealedMaintenance: .1, bonus: .25, traitBonus: .15, reserveCap: 400, foundryInput: 40, foundryOutput: 20, foundryUnity: 1, shipCostDivisor: 3, housingCapacity: 4, hospitalGrowth: .2, growthCap: 2, fleetDiscount: .15, reserveFirst: 2000, reserveSecond: 8000, reserveFirstRate: 10, reserveSecondRate: 40 } as const;
export const industrial = (state: { rulesRevision?: string }) => (state.rulesRevision === INDUSTRY.revision || modernRules(state));
export const EXTRA = {
  foundry: { jobs: 2, limit: 3, alloys: 0, priority: 2 },
  refinery: { jobs: 2, limit: 1, alloys: 0, priority: 1 },
  agriculture: { jobs: 1, limit: 1, alloys: 0, priority: 1 },
  housing: { jobs: 0, limit: 1, alloys: 0, priority: 1 },
  hospital: { jobs: 1, limit: 1, alloys: 0, priority: 3 },
  solar_hub: { jobs: 1, limit: 1, alloys: 40, priority: 1 },
  drydock: { jobs: 2, limit: 1, alloys: 100, priority: 1 },
  habitat: { jobs: 0, limit: 1, alloys: 100, priority: 1 },
  maintenance: { jobs: 1, limit: 1, alloys: 80, priority: 1 },
} as const;
export const LABOR: Record<StructureType, { jobs: number; limit: number; alloys: number; priority: number }> = {
  farm: { jobs: 2, limit: 99, alloys: 0, priority: 5 }, mine: { jobs: 2, limit: 99, alloys: 0, priority: 4 },
  solar: { jobs: 1, limit: 99, alloys: 0, priority: 5 }, shipyard: { jobs: 1, limit: 1, alloys: 0, priority: 1 },
  sanatorium: { jobs: 1, limit: 1, alloys: 0, priority: 3 }, resort: { jobs: 2, limit: 2, alloys: 0, priority: 3 },
  lrs: { jobs: 1, limit: 1, alloys: 0, priority: 3 }, ...EXTRA,
};
export const BUILDING_EFFECTS: Partial<Record<StructureType,string>> = {
  foundry: '每100日40矿物加工20合金；投入产出同倍率；满负荷行星凝聚力-1，上限3',
  refinery: '本行星矿场产出+25%，随自身运营率缩减，不提高合金转换率',
  agriculture: '本行星农场产出+25%，随自身运营率缩减',
  housing: '本行星人口容量+4，无岗位，全额维护',
  hospital: '本行星人口增长+20%，随运营率缩减，不加快殖民',
  solar_hub: '本行星太阳能产出+25%，随运营率缩减',
  drydock: '本行星造舰进度+25%，随运营率缩减，不增加队列',
  habitat: '本行星人口容量+4，无岗位，全额维护',
  maintenance: '每星系最多1座，己方驻留舰船维护-15%，随运营率缩减；不覆盖在途或占领区',
};
export const TRAITS = ['ordinary', 'rich', 'fertile', 'sunny', 'habitable'] as const;
export const TRAIT_NAMES = { ordinary: '普通', rich: '富矿', fertile: '肥沃', sunny: '强日照', habitable: '宜居' };
export const EXPANSIONS = {
  ground1: { slot: 'ground', population: 8, minerals: 300, alloys: 0, days: 300, energy: 5, upkeep: 1 },
  ground2: { slot: 'ground', population: 12, minerals: 600, alloys: 0, days: 500, energy: 5, upkeep: 1 },
  orbital: { slot: 'orbital', population: 10, minerals: 400, alloys: 100, days: 400, energy: 8, upkeep: 2 },
} as const;
export function allocation(planet: Planet, day: number) {
  const result: Record<string, number> = {};
  let remaining = units(planet.population);
  const active = planet.structures.filter(s => !s.sealed && (s.restartUntil ?? 0) <= day);
  for (const s of planet.structures) result[s.id] = 0;
  for (const s of active.filter(s => LABOR[s.type].jobs === 0)) result[s.id] = 1;
  const priority = (s: Structure) => planet.priorities?.[s.type] ?? LABOR[s.type].priority;
  for (const rank of [...new Set(active.map(priority))].sort((a, b) => b - a)) {
    const group = active.filter(s => priority(s) === rank && LABOR[s.type].jobs > 0).sort((a, b) => a.id.localeCompare(b.id));
    const need = group.reduce((n, s) => n + units(LABOR[s.type].jobs), 0);
    const total = Math.min(remaining, need);
    const parts = group.map(s => need ? Math.floor(total * units(LABOR[s.type].jobs) / need) : 0);
    let remainder = total - parts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < group.length; i++) { if (remainder > 0) { parts[i]++; remainder--; } result[group[i].id] = parts[i] / units(LABOR[group[i].type].jobs); }
    remaining -= total;
  }
  return result;
}
export const rates = (planet: Planet, day: number) => planet.operation?.day === day ? planet.operation.rates : allocation(planet, day);
export const operating = (planet: Planet, type: StructureType, day: number) => planet.structures.filter(s => s.type === type).reduce((n, s) => n + (rates(planet, day)[s.id] ?? 0), 0);
export const support = (planet: Planet, type: StructureType, day: number) => Math.min(1, operating(planet, type, day));
export const maintenanceRate = (s: Structure, fraction: number, day: number) => s.sealed ? INDUSTRY.sealedMaintenance : (s.restartUntil ?? 0) > day ? INDUSTRY.idleMaintenance : LABOR[s.type].jobs === 0 ? 1 : INDUSTRY.idleMaintenance + (1-INDUSTRY.idleMaintenance) * fraction;
export const capacity = (planet: Planet, slot: 'ground' | 'orbital') => slot === 'ground' ? RULES.groundSlots + 2 * (planet.expansions?.ground ?? 0) : RULES.orbitalSlots + 2 * Number(planet.expansions?.orbital ?? false);
export const populationCap = (planet: Planet, day: number) => RULES.populationCap + INDUSTRY.housingCapacity * (support(planet, 'housing', day) + support(planet, 'habitat', day));
export function outputBonus(planet: Planet, resource: 'energy' | 'minerals' | 'food', day: number) {
  const type = ({ energy: 'solar_hub', minerals: 'refinery', food: 'agriculture' } as const)[resource];
  const trait = ({ energy: 'sunny', minerals: 'rich', food: 'fertile' } as const)[resource];
  return 1 + INDUSTRY.bonus * support(planet, type, day) + (planet.trait === trait ? INDUSTRY.traitBonus : 0);
}
export function expansionUpkeep(planet: Planet) { const levels = planet.expansions?.ground ?? 0; return { energy: (levels >= 1 ? EXPANSIONS.ground1.energy : 0) + (levels >= 2 ? EXPANSIONS.ground2.energy : 0) + (planet.expansions?.orbital ? EXPANSIONS.orbital.energy : 0), minerals: (levels >= 1 ? EXPANSIONS.ground1.upkeep : 0) + (levels >= 2 ? EXPANSIONS.ground2.upkeep : 0) + (planet.expansions?.orbital ? EXPANSIONS.orbital.upkeep : 0) }; }
export function shipMaterials(type: ShipType): Resources { const value = SHIPS[type].minerals / INDUSTRY.shipCostDivisor; return { energy: 0, food: 0, minerals: units(value), alloys: units(value) }; }
export function reserveScore(resources: Resources) { const value = (resources.minerals + 2 * (resources.alloys ?? 0)) / 1000; return Math.min(value, INDUSTRY.reserveFirst) / INDUSTRY.reserveFirstRate + Math.min(Math.max(0, value - INDUSTRY.reserveFirst), INDUSTRY.reserveSecond) / INDUSTRY.reserveSecondRate; }
export function freezeOperations(state: GameState) {
  if (!industrial(state)) return;
  for (const system of state.systems) for (const planet of system.planets) {
    for (const structure of planet.structures) if (structure.restartUntil !== undefined && structure.restartUntil <= state.day) delete structure.restartUntil;
    const next = allocation(planet, state.day);
    for (const structure of planet.structures) {
      const previous = planet.operation?.rates[structure.id] ?? 0;
      if (previous !== undefined && (previous === 0) !== (next[structure.id] === 0)) state.events.push({ id: 'industry-' + state.day + '-' + structure.id, day: state.day, round: state.round + 1, type: 'economy', systemId: system.id, audience: [system.controllerId ?? system.ownerId ?? planet.ownerId!], text: planet.name + '的' + STRUCTURES[structure.type].name + (next[structure.id] > 0 ? '开始运营' : '停止运营（缺员或封存）'), details: { structureId: structure.id, previous, operation: next[structure.id] } });
    }
    planet.operation = { day: state.day, rates: next };
  }
}
export function industryPlanet(planet: Planet, day: number) {
  const assigned = allocation(planet, day);
  const buildings = planet.structures.map(s => ({ id: s.id, type: s.type, name: STRUCTURES[s.type].name, requiredJobs: LABOR[s.type].jobs, assignedJobs: LABOR[s.type].jobs * assigned[s.id], operation: assigned[s.id], maintenance: maintenanceRate(s, assigned[s.id], day), sealed: !!s.sealed, restartDays: Math.max(0, (s.restartUntil ?? day) - day) }));
  return { planetId: planet.id, trait: planet.trait ?? 'ordinary', population: planet.population, populationCap: populationCap(planet, day), groundSlots: capacity(planet, 'ground'), orbitalSlots: capacity(planet, 'orbital'), jobs: buildings.reduce((n, s) => n + s.requiredJobs, 0), employed: buildings.reduce((n, s) => n + s.assignedJobs, 0), priorities: planet.priorities ?? {}, buildings, expansions: EXPANSIONS, effects: BUILDING_EFFECTS };
}
