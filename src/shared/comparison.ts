import { CIVILIZATION, modern, route, utopiaOperating, V5_POLICIES, welfareQuote } from './civilization.js';
import { INDUSTRY, expansionUpkeep, industrial, allocation, maintenanceRate, outputBonus, support } from './industry.js';
import { BALANCE, annexationFactor, balancedRules, civilizationScore, holyCooperation, warBurden } from './balance.js';
import { POLICIES, cohesionBreakdown, currentPolicy, policyWindow, supplyFactor } from './civil.js';
import type { PolicyId } from './civil.js';
import { BASE, RULES, SHIPS, STRUCTURES } from './rules.js';
import type { GameState } from './types.js';
import { V4, controller, faithEffects, occupied } from './v4.js';

export function policyComparison(state: GameState, actor: string, choices = (modern(state) ? Object.keys(V5_POLICIES) : ['none','militarism','utopia','balanced']) as PolicyId[]) {
  return choices.map(choice => {
    const faction = state.factions[actor];
    const copy = { ...state, factions: { ...state.factions, [actor]: { ...faction, policy: { ...faction.policy!, choice }, beacon: modern(state) || faction.policy?.choice === 'utopia' && choice === 'utopia' ? faction.beacon : undefined } } };
    const policy = currentPolicy(copy, actor);
    const burden = warBurden(copy, actor);
    const fleetMultiplier = burden.multiplier * (modern(state) ? (route(state,actor)==='militarist' ? CIVILIZATION.militaryMaintenance : 1) * (choice==='exercises' ? CIVILIZATION.exerciseMaintenance : 1) : 1);
    const production = { energy: 0, food: 0, minerals: 0, alloys: 0 };
    let processingInput = 0;
    const upkeep = { energy: burden.base.energy * fleetMultiplier, food: 0, minerals: burden.base.minerals * fleetMultiplier };
    const cooperation = holyCooperation(copy, actor) ? (modern(state) ? CIVILIZATION.holyProduction : BALANCE.holyProduction) : 1;
    for (const system of state.systems.filter(system => controller(system) === actor)) {
      if (system.base && (system.base.disabledUntil ?? 0) <= state.day) { upkeep.energy += BASE.energy; upkeep.minerals += BASE.upkeep; }
      const factor = (0.5 + faction.unity / 10000) * supplyFactor(faction.shortages) * faithEffects(faction, state.day).production * cooperation * (occupied(system) ? V4.occupationProduction : balancedRules(state) ? annexationFactor(system) : 1);
      for (const planet of system.planets.filter(planet => planet.population)) {
        upkeep.food += planet.population * RULES.foodPerPopulation;
        const assigned = industrial(state) ? allocation(planet, state.day) : {};
        if (industrial(state)) { upkeep.energy += expansionUpkeep(planet).energy; upkeep.minerals += expansionUpkeep(planet).minerals; }
        for (const structure of planet.structures) {
          const fraction = industrial(state) ? assigned[structure.id] : 1;
          let maintenance = industrial(state) ? maintenanceRate(structure, fraction, state.day) : 1;
          if (modern(state) && choice==='listening' && structure.type==='lrs' && fraction===1 && !occupied(system) && !faction.shortages.energy && !faction.shortages.minerals) maintenance *= CIVILIZATION.listeningMaintenance;
          const rule = STRUCTURES[structure.type]; upkeep.energy += rule.energy * maintenance; upkeep.minerals += rule.upkeep * maintenance;
          for (const resource of ['energy', 'minerals', 'food'] as const) production[resource] += rule.output[resource] * factor * policy[resource] * fraction * (industrial(state) ? outputBonus({...planet, operation: undefined}, resource, state.day) : 1);
          if (industrial(state) && structure.type === 'foundry') processingInput += INDUSTRY.foundryInput * factor * fraction;
        }
      }
    }
    // Station maintenance discounts are part of baseline upkeep, before welfare affordability.
    if (industrial(state)) {
      for (const system of state.systems.filter(s => controller(s) === actor && !occupied(s))) {
        const discount = INDUSTRY.fleetDiscount * Math.min(1, system.planets.reduce((n,p) => n + support({...p, operation: undefined}, 'maintenance', state.day), 0));
        for (const ship of state.fleets.filter(f => f.ownerId === actor && f.systemId === system.id).flatMap(f => f.ships)) { upkeep.energy -= SHIPS[ship.type].energy * fleetMultiplier * discount; upkeep.minerals -= SHIPS[ship.type].upkeep * fleetMultiplier * discount; }
      }
    }
    const welfare = modern(state) ? welfareQuote(copy,actor) : null;
    const welfarePaid = { energy: 0, food: 0, minerals: 0 };
    if (welfare) {
      const keys = ['energy','food','minerals'] as const;
      const ratio = Math.min(1,...keys.map(k=>welfare.deliverable[k] ? Math.max(0,faction.resources[k]/1000*10+production[k]-upkeep[k])/(welfare.deliverable[k]/1000) : 1));
      for (const k of keys) { welfarePaid[k] = welfare.deliverable[k]/1000*ratio; upkeep[k] += welfarePaid[k]; }
      copy.factions[actor].welfare = {...faction.welfare!,last:{day:state.day,...welfare,paid:{energy:Math.round(welfarePaid.energy*1000),minerals:Math.round(welfarePaid.minerals*1000),food:Math.round(welfarePaid.food*1000)},fraction:welfare.population?ratio*welfare.reachablePopulation/welfare.population:1,reasons:ratio<1?['静态预算不足']:[]}};
    }
    if (industrial(state)) {
      const used = Math.min(processingInput, Math.max(0, faction.resources.minerals / 1000 * 10 - upkeep.minerals));
      production.alloys = used * INDUSTRY.foundryOutput / INDUSTRY.foundryInput; upkeep.minerals += used;
    }
    const cohesion = cohesionBreakdown(copy, actor);
    return { choice, name: policy.name, selectionTerm: policyWindow(state, actor), selectableNow: policyWindow(state, actor) !== null && !(choice === 'utopia' && faction.faith), selectionBlocker: choice === 'utopia' && faction.faith ? '永久国教禁止乌托邦' : policyWindow(state, actor) === null ? '本届已锁定或下届选择窗口未开放' : null, allowed: !(choice === 'utopia' && faction.faith), effects: policy, production, upkeep, net: { alloys: production.alloys, energy: production.energy - upkeep.energy, minerals: production.minerals - upkeep.minerals, food: production.food - upkeep.food }, cohesion, effectiveUnityChange: Math.min(100 - faction.unity / 100, Math.max(-faction.unity / 100, cohesion.total)), welfarePaid, fleetMultiplier, processing: { requestedMinerals: processingInput, availableOpeningMineralsPerStep: Math.max(0,faction.resources.minerals/1000-(upkeep.minerals-production.alloys*2)/10), alloyOutput: production.alloys }, populationGrowth: modern(state) ? (utopiaOperating(copy,actor) ? CIVILIZATION.utopiaGrowth : 1)*(choice==='exchange' && Object.values(state.relations).some(r=>r.factions.includes(actor)&&r.status==='peace') ? CIVILIZATION.exchangeGrowth : 1) : balancedRules(state) && choice === 'utopia' ? BALANCE.utopiaGrowth : 1, capNote: '凝聚力封顶时额外正收益不转化资源；生产、人口、灯塔与文明成果仍按各自条件生效', estimate: '当前设施、人口、舰队、凝聚力与短缺固定的静态每100日估算；不含未来建设、战损、维修和未来短缺变化' };
  });
}
export function balanceSummary(state: GameState, actor: string) {
  return { revision: state.rulesRevision ?? '4.0', costs: warBurden(state, actor), policies: policyComparison(state, actor), civilization: civilizationScore(state, actor), holyCooperation: holyCooperation(state, actor), stableFaith: state.factions[actor].stableFaith ?? null, rules: balancedRules(state) ? BALANCE : null };
}
