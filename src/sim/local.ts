import { CIVILIZATION } from '../shared/civilization.js';
import { V53 } from '../shared/governance.js';
import { INDUSTRY, expansionUpkeep, EXPANSIONS, rates, support, outputBonus, populationCap, maintenanceRate } from '../shared/industry.js';
import { annexationFactor } from '../shared/balance.js';
import { POLICIES } from '../shared/civil.js';
import { performance } from 'node:perf_hooks';
import { BASE, factionRecord, RULES, SHIPS, SHIP_ORDER, STRUCTURES, units } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Faction, Fleet, LocalEvent, Point, Relation, Resources, StarSystem } from '../shared/types.js';
import { distance, fleetPower, productivity, segmentDistance, shortageMultiplier, seedNumber } from './math.js';

import { canFight, relationKey } from '../shared/diplomacy.js';
import { V4, controller, occupied, operational } from '../shared/v4.js';
import type { War } from '../shared/v4.js';
import type { CaptureIntent } from './wars.js';

export interface FactionFactors { parallel?: boolean; welfareQuote?: ReturnType<typeof import("../shared/civilization.js").welfareQuote>; civilizationRoute?: string; shipSpeed?: number; civilizationCombat?: number; exerciseCombat?: number; listening?: boolean; industry?: boolean; openingMinerals?: number; balance?: boolean; warUpkeep?: number; warUnity?: number; holyProduction?: number; holyScore?: number; populationGrowth?: number; stableFaithInterval?: boolean; unity: number; shortages: Faction['shortages']; policy?: Faction['policy']; faith?: Faction['faith']; beacon?: Faction['beacon']; faithProduction?: number; faithCombat?: number; policyEffects?: { energy: number; food: number; minerals: number; combat: number } }
const combatFactor = (faction: FactionFactors) => shortageMultiplier(faction.shortages) * (faction.policyEffects ?? POLICIES[faction.policy?.choice ?? 'none']).combat * (faction.faithCombat ?? 1) * (faction.civilizationCombat ?? 1);
export interface LocalInput {
  wars?: War[];
  seed: string;
  relations: Record<string, Relation>;
  phase: 'advance' | 'combat' | 'economy';
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  factions: Record<FactionId, FactionFactors>;
}
export interface LocalOutput {
  economicDetails: { operations?: { structureId: string; type: string; fraction: number; maintenance: number; energy: number; minerals: number }[]; infrastructure?: {energy:number;minerals:number}; factionId: string; systemId: string; planetId: string; annexationMultiplier: number; holyMultiplier: number; production: Resources; integrationLoss: Resources; growthDays: number; populationCap?: number; nonUtopiaGrowth?: number }[];
  processing: { actor: string; planetId: string; systemId: string; structureId: string; input: number; output: number }[];
  captures: CaptureIntent[];
  consecrations: { actor: string; planetId: string }[];
  systems: StarSystem[];
  fleets: Fleet[];
  events: LocalEvent[];
  surveys: { factionId: FactionId; systemId: string }[];
  income: Record<FactionId, Resources>;
  upkeep: Record<FactionId, Resources>;
  durationMs: number;
  battles: string[];
}

const resourceZero = (): Resources => ({ energy: 0, food: 0, minerals: 0 });

function travel(fleet: Fleet, system: StarSystem, fleets: Fleet[], events: LocalEvent[], day: number) {
  fleet.previousPosition = { ...fleet.position };
  if (!fleet.order) return;
  const order = fleet.order;
  if (order.targetFleetId) {
    const target = fleets.find(candidate => candidate.id === order.targetFleetId && candidate.systemId === system.id && candidate.ownerId !== fleet.ownerId);
    if (target) { order.position = { ...target.position }; order.systemId = system.id; order.route = []; }
  }
  const speed = Math.min(...fleet.ships.map(ship => SHIPS[ship.type].speed));
  const availableDays = fleet.movementDays ?? RULES.tickDays;
  const destination = order.route.length ? system.gates[order.route[0]] : order.position;
  if (!destination) { fleet.order = null; return; }
  const length = distance(fleet.position, destination);
  const allowance = speed * availableDays;
  if (length > allowance) {
    fleet.position = { x: fleet.position.x + (destination.x - fleet.position.x) / length * allowance, y: fleet.position.y + (destination.y - fleet.position.y) / length * allowance };
    return;
  }
  fleet.position = { ...destination };
  if (order.route.length) {
    const to = order.route.shift()!;
    fleet.transit = { from: system.id, to, remainingDays: RULES.jumpDays - (availableDays - length / speed) };
    fleet.departedDay = day;
    fleet.systemId = null;
    events.push({ day, type: 'movement', text: `${fleet.name}驶入前往 ${to} 的超空间航道`, systemId: system.id, audience: [fleet.ownerId] });
  } else if (!order.targetFleetId) fleet.order = null;
}

function advance(system: StarSystem, fleets: Fleet[], input: LocalInput, output: LocalOutput) {
  const activeShipyards = new Map<string, number>();
  const activeConstruction = new Map<string, number>();
  const shipLines = new Map(system.planets.map(p => {
    const f = p.ownerId ? input.factions[p.ownerId] : undefined;
    return [p.id, f?.parallel && !f.shortages.energy && !f.shortages.minerals && support(p, 'drydock', input.day - RULES.tickDays) === 1 ? V53.drydockShipLines : V53.normalShipLines];
  }));
  const finished = new Set<string>();
  for (const project of (Object.values(input.factions).some(f => f.industry) ? [...system.projects].sort((a,b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id)) : system.projects)) {
    const faction = input.factions[project.ownerId];
    const planet = system.planets.find(candidate => candidate.id === project.planetId);
    if (occupied(system) && project.kind !== 'survey' && project.kind !== 'base') continue;
    if (project.kind !== 'survey' && project.kind !== 'base' && system.ownerId !== project.ownerId) { finished.add(project.id); continue; }
    if (project.kind === 'ship') {
      if (!planet?.structures.some(structure => structure.type === 'shipyard') || (activeShipyards.get(planet.id) ?? 0) >= shipLines.get(planet.id)!) continue;
      activeShipyards.set(planet.id, (activeShipyards.get(planet.id) ?? 0) + 1);
    }
    if (faction.industry && planet && (project.kind === 'building' || project.kind === 'expansion')) {
      const slot = project.expansion ? EXPANSIONS[project.expansion].slot : STRUCTURES[project.structureType!].slot;
      const key = planet.id + ':' + slot;
      if ((activeConstruction.get(key) ?? 0) >= (faction.parallel ? V53.constructionLines : 1)) continue;
      activeConstruction.set(key, (activeConstruction.get(key) ?? 0) + 1);
    }
    const shipFactor = faction.industry && planet && project.kind === 'ship' ? support(planet, 'shipyard', input.day - RULES.tickDays) * (1 + INDUSTRY.bonus * support(planet, 'drydock', input.day - RULES.tickDays)) : 1;
    const fixed = project.kind === 'survey' || project.kind === 'colonize' || project.kind === 'consecrate';
    project.progress += Math.round(units(RULES.tickDays) * (fixed ? 1 : shipFactor * (project.kind === 'ship' ? faction.shipSpeed ?? 1 : 1) * productivity(faction) * (faction.faithProduction ?? 1) * (faction.balance ? annexationFactor(system, input.day - RULES.tickDays) : 1)));
    if (project.progress < units(project.requiredDays)) continue;
    finished.add(project.id);
    const emit = (type: LocalEvent['type'], text: string) => output.events.push({ day: input.day, type, text, systemId: system.id, audience: [project.ownerId] });
    if (project.kind === 'survey') {
      output.surveys.push({ factionId: project.ownerId, systemId: system.id });
      emit('exploration', `${system.name}探索完成，发现${system.planets.length}颗行星`);
    } else if (project.kind === 'base') {
      if (!system.ownerId) {
        system.ownerId = project.ownerId; system.base = { hull: BASE.power };
        for (const existingPlanet of system.planets) if (existingPlanet.population > 0) existingPlanet.ownerId = project.ownerId;
        emit('construction', `${system.name}恒星基地投入运行，主权建立`);
      }
    } else if (project.kind === 'consecrate' && planet) {
      output.consecrations.push({ actor: project.ownerId, planetId: planet.id });
    } else if (project.kind === 'colonize' && planet && !planet.ownerId) {
      planet.ownerId = project.ownerId; planet.population = 2; planet.growthDays = 0;
      emit('colony', `${planet.name}殖民完成，获得2人口`);
    } else if (project.kind === 'expansion' && planet && project.expansion) {
      planet.expansions ??= { ground: 0, orbital: false };
      if (project.expansion === 'orbital') planet.expansions.orbital = true; else planet.expansions.ground++;
      emit('construction', `${planet.name}槽位扩建完成：${project.expansion}`);
    } else if (project.kind === 'building' && planet && project.structureType) {
      planet.structures.push({ id: `${project.id}-structure`, type: project.structureType });
      emit('construction', `${planet.name}的${STRUCTURES[project.structureType].name}建造完成`);
    } else if (project.kind === 'ship' && planet && project.shipType) {
      const ship = { id: `${project.id}-ship`, type: project.shipType, hull: SHIPS[project.shipType].power };
      const docked = fleets.find(fleet => fleet.ownerId === project.ownerId && !fleet.order && fleet.systemId === system.id && distance(fleet.position, planet.position) < 1);
      if (docked) docked.ships.push(ship);
      else fleets.push({ id: `${project.id}-fleet`, name: `${system.name}机动舰队`, ownerId: project.ownerId, systemId: system.id, position: { ...planet.position }, transit: null, order: null, ships: [ship] });
      emit('construction', `${planet.name}建成一艘${SHIPS[project.shipType].name}`);
    }
  }
  system.projects = system.projects.filter(project => !finished.has(project.id));
  const beforeMovement = structuredClone(fleets);
  for (const fleet of fleets) travel(fleet, system, beforeMovement, output.events, input.day);
}

interface CombatUnit { id: string; ownerId: FactionId; position: Point; previous: Point; fleet: Fleet | null; base: boolean }

function battle(system: StarSystem, fleets: Fleet[], input: LocalInput, output: LocalOutput) {
  const pairs = Object.values(input.relations).filter(canFight).map(relation => relation.factions);
  pairs.sort((first, second) => seedNumber(`${input.seed}:${input.day}:${system.id}:${relationKey(...first)}`) - seedNumber(`${input.seed}:${input.day}:${system.id}:${relationKey(...second)}`) || relationKey(...first).localeCompare(relationKey(...second)));
  for (const pair of pairs) duel(system, fleets, input, output, pair);
}

function duel(system: StarSystem, fleets: Fleet[], input: LocalInput, output: LocalOutput, pair: [string, string]) {
  const unitsInBattle: CombatUnit[] = fleets.filter(fleet => pair.includes(fleet.ownerId) && fleet.ships.length && (!fleet.withdrawal || !pair.includes(fleet.withdrawal.hostId))).map(fleet => ({ id: fleet.id, ownerId: fleet.ownerId, position: fleet.position, previous: fleet.previousPosition ?? fleet.position, fleet, base: false }));
  if (operational(system, input.day - RULES.tickDays) && controller(system) && pair.includes(controller(system)!)) unitsInBattle.push({ id: `${system.id}-base`, ownerId: controller(system)!, position: { x: 500, y: 500 }, previous: { x: 500, y: 500 }, fleet: null, base: true });
  const parent = unitsInBattle.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  for (let first = 0; first < unitsInBattle.length; first++) for (let second = first + 1; second < unitsInBattle.length; second++) {
    const firstUnit = unitsInBattle[first];
    const secondUnit = unitsInBattle[second];
    if (firstUnit.ownerId !== secondUnit.ownerId && segmentDistance(firstUnit.previous, firstUnit.position, secondUnit.previous, secondUnit.position) <= RULES.engagementRange) parent[root(second)] = root(first);
  }
  const groups = new Map<number, CombatUnit[]>();
  unitsInBattle.forEach((unit, index) => { const key = root(index); groups.set(key, [...groups.get(key) ?? [], unit]); });
  for (const group of groups.values()) {
    if (new Set(group.map(unit => unit.ownerId)).size < 2) continue;
    const participants = structuredClone(group.map(unit => ({ id: unit.id, ownerId: unit.ownerId, ships: unit.fleet?.ships ?? [], baseHull: unit.base ? system.base?.hull : undefined, position: unit.position })));
    const power = Object.fromEntries(pair.map(factionId => [factionId, group.filter(unit => unit.ownerId === factionId).reduce((sum, unit) => sum + (unit.fleet ? fleetPower(unit.fleet) * (input.factions[factionId].exerciseCombat ?? 1) : system.base?.hull ?? 0), 0) * combatFactor(input.factions[factionId])])) as Record<FactionId, number>;
    const tie = Math.abs(power[pair[0]] - power[pair[1]]) < 0.000001;
    const winner = tie ? null : power[pair[0]] > power[pair[1]] ? pair[0] : pair[1];
    const loser = winner === pair[0] ? pair[1] : pair[0];
    output.battles.push(relationKey(...pair));
    const originalOwner = system.ownerId;
    const originalController = controller(system);
    let baseDestroyed = false;
    for (const unit of group) {
      if (!winner || unit.ownerId !== winner) {
        if (unit.fleet) unit.fleet.ships = [];
        else { system.base = null; baseDestroyed = true; }
      }
    }
    if (winner) {
      let damage = power[loser] * RULES.winnerDamageFraction / combatFactor(input.factions[winner]);
      const exercise = input.factions[winner].exerciseCombat ?? 1;
      const ships = group.filter(unit => unit.ownerId === winner && unit.fleet).flatMap(unit => unit.fleet!.ships).sort((first, second) => SHIP_ORDER.indexOf(first.type) - SHIP_ORDER.indexOf(second.type) || first.id.localeCompare(second.id));
      for (const ship of ships) { const inflicted = Math.min(ship.hull, damage / exercise); ship.hull = Math.round((ship.hull - inflicted) * 1000) / 1000; damage -= inflicted * exercise; }
      if (damage > 0 && group.some(unit => unit.base && unit.ownerId === winner) && system.base) system.base.hull = Math.max(0, Math.round((system.base.hull - damage) * 1000) / 1000);
    }
    for (const fleet of fleets) fleet.ships = fleet.ships.filter(ship => ship.hull > 0);
    output.events.push({ day: input.day, type: 'battle', details: { pair, order: output.events.filter(event => event.type === 'battle' && event.systemId === system.id).length + 1, participants, modifiers: Object.fromEntries(pair.map(id => [id, combatFactor(input.factions[id])])), ...(Object.values(input.factions).some(f=>f.civilizationRoute) ? { fleetModifiers:Object.fromEntries(pair.map(id=>[id,combatFactor(input.factions[id])*(input.factions[id].exerciseCombat??1)])), baseModifiers:Object.fromEntries(pair.map(id=>[id,combatFactor(input.factions[id])])) } : {}), effectivePower: power, winner, remaining: structuredClone(group.map(unit => ({ id: unit.id, ships: unit.fleet?.ships ?? [], baseHull: unit.base ? system.base?.hull : undefined }))) }, text: `${system.name}发生战斗：${pair[0]} ${power[pair[0]].toFixed(1)} / ${pair[1]} ${power[pair[1]].toFixed(1)}，${winner ? winner + '获胜' : '双方同归于尽'}`, systemId: system.id, audience: [...pair] });
    if (baseDestroyed) {
      const captor = winner && group.some(unit => unit.ownerId === winner && unit.fleet?.ships.length) ? winner : null;
      if (input.wars) {
        output.captures.push({ systemId: system.id, previousOwner: originalOwner, previousController: originalController, captor, pair });
        const war = input.wars.find(war => war.endedDay === undefined && war.factions.includes(originalOwner!) && war.factions.includes(captor ?? pair.find(id => id !== originalOwner)!));
        const legalRelation = captor && originalOwner ? input.relations[relationKey(captor, originalOwner)] : input.relations[relationKey(...pair)];
        if (war?.type === 'total') {
          system.ownerId = captor; delete system.controllerId;
          for (const planet of system.planets) if (planet.ownerId) planet.ownerId = captor;
          system.base = captor ? { hull: BASE.power / 2 } : null;
        } else {
          system.controllerId = captor && originalOwner && captor !== originalOwner && !canFight(legalRelation) ? originalOwner : captor ?? originalController;
          system.base = captor ? { hull: BASE.power / 2 } : { hull: 0, disabledUntil: input.day + V4.ruinDays };
        }
        continue;
      }
      system.ownerId = captor;
      system.base = captor ? { hull: BASE.power * 0.5 } : null;
      for (const planet of system.planets) if (planet.ownerId) planet.ownerId = captor;
      system.projects = system.projects.filter(project => project.ownerId !== originalOwner);
      output.events.push({ day: input.day, type: 'capture', details: { previousOwner: originalOwner, ownerId: captor, base: system.base }, text: `${system.name}${captor ? `被${captor}占领` : '基地被摧毁，主权丧失'}，原主未完成项目取消`, systemId: system.id, audience: [...pair] });
    }
  }
}

function economy(system: StarSystem, fleets: Fleet[], input: LocalInput, output: LocalOutput) {
  const portion = RULES.tickDays / RULES.daysPerRound;
  const interval = input.day - RULES.tickDays;
  if (controller(system) && operational(system, input.day - RULES.tickDays)) {
    output.upkeep[controller(system)!].energy += units(BASE.energy * portion);
    output.upkeep[controller(system)!].minerals += units(BASE.upkeep * portion);
  }
  for (const planet of system.planets) {
    if (!planet.ownerId || !planet.population) continue;
    const ownerId = controller(system) ?? planet.ownerId;
    const faction = input.factions[ownerId];
    const factor = productivity(faction) * (faction.faithProduction ?? 1) * (faction.holyProduction ?? 1) * (occupied(system) ? V4.occupationProduction : faction.balance ? annexationFactor(system, input.day - RULES.tickDays) : 1);
    output.upkeep[ownerId].food += units(planet.population * RULES.foodPerPopulation * portion);
    const detail = { factionId: ownerId, systemId: system.id, planetId: planet.id, annexationMultiplier: faction.balance ? annexationFactor(system, input.day - RULES.tickDays) : 1, holyMultiplier: faction.holyProduction ?? 1, production: resourceZero(), integrationLoss: resourceZero(), growthDays: 0, ...(faction.civilizationRoute ? { populationCap: 0, nonUtopiaGrowth: 1 } : {}), ...(faction.industry ? { productivity: factor, operations: [] as { structureId: string; type: string; fraction: number; maintenance: number; energy: number; minerals: number }[], infrastructure: expansionUpkeep(planet) } : {}) };
    const assigned = faction.industry ? rates(planet, interval) : {};
    const cap = faction.industry ? populationCap(planet, interval) : RULES.populationCap;
    const growth = faction.industry ? Math.min(INDUSTRY.growthCap, (faction.populationGrowth ?? 1) * (1 + INDUSTRY.hospitalGrowth * support(planet, 'hospital', interval) + (planet.trait === 'habitable' ? INDUSTRY.traitBonus : 0))) : (faction.populationGrowth ?? 1);
    if(faction.civilizationRoute) { detail.populationCap=cap; detail.nonUtopiaGrowth=(faction.populationGrowth??1)/(faction.civilizationRoute==='utopia' && (faction.populationGrowth??1)>=CIVILIZATION.utopiaGrowth ? CIVILIZATION.utopiaGrowth:1)*(1+INDUSTRY.hospitalGrowth*support(planet,'hospital',interval)+(planet.trait==='habitable'?INDUSTRY.traitBonus:0)); }
    if (faction.industry) {
      Object.assign(detail, { workforce: assigned, trait: planet.trait, expansions: planet.expansions });
      const infrastructure = expansionUpkeep(planet);
      output.upkeep[ownerId].energy += units(infrastructure.energy * portion);
      output.upkeep[ownerId].minerals += units(infrastructure.minerals * portion);
    }
    for (const structure of planet.structures) {
      const fraction = faction.industry ? (assigned[structure.id] ?? 0) : 1;
      const maintenance = (faction.industry ? maintenanceRate(structure, fraction, interval) : 1) * (faction.listening && structure.type === 'lrs' && fraction === 1 && !faction.shortages.energy && !faction.shortages.minerals && !occupied(system) ? CIVILIZATION.listeningMaintenance : 1);
      const rule = STRUCTURES[structure.type];
      detail.operations?.push({ structureId: structure.id, type: structure.type, fraction, maintenance, energy: units(rule.energy * portion * maintenance), minerals: units(rule.upkeep * portion * maintenance) });
      output.upkeep[ownerId].energy += units(rule.energy * portion * maintenance);
      output.upkeep[ownerId].minerals += units(rule.upkeep * portion * maintenance);
      for (const resource of ['energy', 'food', 'minerals'] as const) {
        const amount = units(rule.output[resource] * factor * fraction * (faction.industry ? outputBonus(planet, resource, interval) : 1) * (faction.policyEffects ?? POLICIES[faction.policy?.choice ?? 'none'])[resource] * portion);
        output.income[ownerId][resource] += amount;
        detail.production[resource] += amount;
        detail.integrationLoss[resource] += Math.round(amount / detail.annexationMultiplier - amount);
      }
      if (faction.industry && structure.type === 'foundry' && fraction > 0) output.processing.push({ actor: ownerId, planetId: planet.id, systemId: system.id, structureId: structure.id, input: units(INDUSTRY.foundryInput * factor * fraction * portion), output: units(INDUSTRY.foundryOutput * factor * fraction * portion) });
    }
    if (!faction.civilizationRoute && !occupied(system) && !Object.values(faction.shortages).some(Boolean)) {
      detail.growthDays = planet.population < cap ? RULES.tickDays * growth * (faction.balance ? annexationFactor(system, input.day - RULES.tickDays) : 1) : 0;
      planet.growthDays += RULES.tickDays * growth * (faction.balance ? annexationFactor(system, input.day - RULES.tickDays) : 1);
      if (planet.growthDays >= RULES.populationGrowthDays && planet.population < cap) {
        planet.population++;
        planet.growthDays = faction.balance ? planet.growthDays - RULES.populationGrowthDays : 0;
        output.events.push({ day: input.day, type: 'population', text: `${planet.name}人口增长至${planet.population}`, systemId: system.id, audience: [ownerId] });
      }
      if (planet.population >= cap) planet.growthDays = 0;
    }
    if (faction.balance) output.economicDetails.push(detail);
  }
  for (const fleet of fleets) for (const ship of fleet.ships) {
    const discount = input.factions[fleet.ownerId].industry && fleet.systemId === system.id && controller(system) === fleet.ownerId && !occupied(system) ? 1 - INDUSTRY.fleetDiscount * Math.min(1, system.planets.reduce((n,p) => n + support(p, 'maintenance', interval), 0)) : 1;
    const rule = SHIPS[ship.type];
    output.upkeep[fleet.ownerId].energy += units(rule.energy * portion * (input.factions[fleet.ownerId].warUpkeep ?? 1) * discount);
    output.upkeep[fleet.ownerId].minerals += units(rule.upkeep * portion * (input.factions[fleet.ownerId].warUpkeep ?? 1) * discount);
  }
}

export function processLocal(input: LocalInput): LocalOutput {
  const started = performance.now();
  const output: LocalOutput = { processing: [], economicDetails: [], systems: input.systems, fleets: input.fleets, events: [], surveys: [], captures: [], consecrations: [], income: factionRecord(Object.keys(input.factions), resourceZero), upkeep: factionRecord(Object.keys(input.factions), resourceZero), durationMs: 0, battles: [] };
  for (const system of input.systems) {
    const localFleets = output.fleets.filter(fleet => fleet.systemId === system.id || input.phase === 'combat' && fleet.departedDay === input.day && fleet.transit?.from === system.id);
    if (input.phase === 'advance') {
      advance(system, localFleets, input, output);
      const originalIds = new Set(output.fleets.map(fleet => fleet.id));
      output.fleets.push(...localFleets.filter(fleet => !originalIds.has(fleet.id)));
    }
    if (input.phase === 'combat') battle(system, localFleets, input, output);
    if (input.phase === 'economy') economy(system, localFleets, input, output);
  }
  output.fleets = output.fleets.filter(fleet => fleet.ships.length);
  output.durationMs = performance.now() - started;
  return output;
}
