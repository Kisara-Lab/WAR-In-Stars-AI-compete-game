import { actionLimit, governed } from '../shared/governance.js';
import { emergencyRules, emergencyView } from '../shared/emergency.js';
import { extractionReasons } from './emergency.js';
import { responsible, decisionBalanced, responsibilityView } from '../shared/responsibility.js';
import { modern, route, civilizationEligibility, welfareQuote } from '../shared/civilization.js';
import { industrial, industryPlanet, support, shipMaterials } from '../shared/industry.js';
import { constructionOptions, resourcePurposes } from './industry.js';
import { balancedRules } from '../shared/balance.js';
import { policyComparison } from '../shared/comparison.js';
import { decisionComparison } from './options.js';
import { borders, conquestFor, ESCALATION, revised, warReasons } from '../shared/escalation.js';
import { observation } from './intel.js';
import { policyWindow } from '../shared/civil.js';
import { performance } from 'node:perf_hooks';
import { RULES, SHIPS, units } from '../shared/rules.js';
import type { FactionId, StructureType } from '../shared/rules.js';
import type { Decision, GameState } from '../shared/types.js';
import { StagingArea } from './actions.js';
import { distance, fleetPower, shortestPath } from './math.js';

import { relationship, canFight } from '../shared/diplomacy.js';
import { activeWar, controller, occupied } from '../shared/v4.js';

export const emptyMetrics = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, reportedModel: '' });

export function scriptedDecision(original: GameState, factionId: FactionId): Decision {
  const started = performance.now();
  // Script planning returns commands, not this private draft's narrative history.
  // Keep the public world's full event stream for the recorder and settlement.
  const stage = new StagingArea(decisionBalanced(original)?{...original,events:[]}:original, factionId);
  const act = (name: string, args: Record<string, unknown>) => stage.actions.length < actionLimit(stage.draft) && stage.execute(name, args).ok;
  const faction = () => stage.draft.factions[factionId];
  const owned = () => stage.draft.systems.filter(system => system.ownerId === factionId && !occupied(system));
  const colonies = () => owned().flatMap(system => system.planets).filter(planet => planet.ownerId === factionId);
  const pending = (planetId: string, type: StructureType) => stage.draft.systems.some(system => system.projects.some(project => project.planetId === planetId && project.structureType === type));

  if(emergencyRules(original)) {
    const view=emergencyView(original,factionId)!;
    if(view.available&&((faction().faith?.crisis??0)>=70||(faction().welfare?.last?.fraction??1)<.5))act('activate_extraction',{});
    for(const e of view.events){
      if(e.stoppedDay!==undefined)continue;
      if(e.target===factionId){
        const d=e.demands.find(d=>d.acceptedDay===undefined&&d.day<original.day);
        if(d){const net=policyComparison(stage.draft,factionId,[faction().policy?.choice??'none'])[0].net;
          if(net.food>=0&&net.energy>=0||activeWar(original,factionId,d.actor))act('accept_stop_extraction',{demandId:d.id});
          else if(d.rejectedDay===undefined)act('reject_stop_extraction',{demandId:d.id});}
      } else if(route(original,factionId)==='utopia'&&!e.demands.length)act('demand_stop_extraction',{factionId:e.target,eventId:e.id});
    }
    for(const reason of extractionReasons(stage.draft,factionId).filter(r=>r.usableDay<=original.day)){
      const comparison=decisionComparison(stage.draft,factionId,false);
      // Use dated own intelligence and the same command validator; no observer fleet totals.
      for(const system of Object.values(faction().intel).map(i=>i.system).filter(s=>s.ownerId===reason.target)){
        if(!comparison||stage.actions.length>=actionLimit(original))break;
        if(act('declare_war',{factionId:reason.target,warType:'humanitarian',systemIds:[system.id],grievanceId:reason.id,reason:'停止强制征收，承担救援责任'}))break;
      }
    }
  }

  if(responsible(original)) {
    const social=responsibilityView(original,factionId)!;
    const f=faction();
    if(['secular','militarist'].includes(route(stage.draft,factionId))&&(f.welfare!.firstChoice||original.day>=f.welfare!.selectedDay+360)){
      const current=policyComparison(stage.draft,factionId,[f.policy?.choice??'none'])[0];
      if(['energy','minerals','food'].some(k=>current.net[k as 'energy'|'minerals'|'food']<0&&f.resources[k as 'energy'|'minerals'|'food']<units(250))){
        for(const choice of ['comfortable','basic','survival'] as const){
          const draft=structuredClone(stage.draft);draft.factions[factionId].welfare!.choice=choice;
          const estimate=policyComparison(draft,factionId,[f.policy?.choice??'none'])[0];
          if(estimate.net.food>=0&&estimate.net.energy>=0&&estimate.net.minerals>=0||choice==='survival'){if(choice!==f.welfare!.choice)act('set_welfare',{welfare:choice});break;}
        }
      }
    }
    for(const offer of social.aid.filter(a=>a.target===factionId&&a.acceptedDay===undefined&&a.endedDay===undefined&&a.expiresDay>original.day))act('accept_aid',{proposalId:offer.id});
    for(const offer of social.reforms.filter(r=>r.target===factionId&&r.acceptedDay===undefined&&r.endedDay===undefined&&r.offerUntil>original.day)) {
      const estimate=policyComparison(stage.draft,factionId,[faction().policy?.choice??'none'])[0];
      if(estimate.net.food>=0&&estimate.net.energy>=0||Object.values(original.relations).some(r=>r.factions.includes(factionId)&&r.factions.includes(offer.actor)&&r.status==='war'))act('accept_reform',{proposalId:offer.id});
    }
    if(route(original,factionId)==='utopia')for(const concern of social.concerns.filter(c=>c.closedDay===undefined&&c.target!==factionId)){
      if(social.aid.some(a=>a.actor===factionId&&a.target===concern.target&&a.endedDay===undefined)||social.reforms.some(r=>r.actor===factionId&&r.target===concern.target&&r.endedDay===undefined))continue;
      const estimate=policyComparison(stage.draft,factionId,[faction().policy?.choice??'none'])[0];
      if(estimate.net.food>0&&estimate.net.energy>0&&faction().resources.food>units(900)&&faction().resources.minerals>units(500))act('offer_aid',{factionId:concern.target,concernId:concern.id});
      else act('propose_reform',{factionId:concern.target,concernId:concern.id});
    }
  }

  if (modern(original) && route(stage.draft,factionId)==='secular') {
    const f=faction();
    if(civilizationEligibility(stage.draft,factionId,'utopia').allowed) act('establish_civilization',{civilization:'utopia',acknowledgePermanent:true});
    else if((f.welfare?.firstChoice || original.day >= (f.welfare?.selectedDay??0)+360) && f.unity>=8000 && original.config.maxRounds-original.round>22) {
      const draft=structuredClone(stage.draft); draft.factions[factionId].welfare!.choice='utopian';
      const estimate=policyComparison(draft,factionId,[f.policy?.choice??'none'])[0];
      if(estimate.net.food>0&&estimate.net.energy>0&&estimate.net.minerals>20&&f.welfare?.choice!=='utopian') act('set_welfare',{welfare:'utopian'});
    }
  }
  if (balancedRules(original)) {
    const comparison = decisionComparison(original, factionId, false);
    const viableHoly = comparison.religion.candidates.find(item => item.allowed && owned().some(system => system.id === item.systemId && system.planets.some(planet => planet.id === item.planetId && planet.population)));
    if (!faction().faith && viableHoly && faction().resources.minerals > units(600) && faction().resources.food > units(300) && faction().unity >= 6000 && faction().policy?.choice !== 'utopia') act('establish_religion', { planetId: viableHoly.planetId, name: faction().name + '星海教', doctrine: '保护已控制的圣地，维持供给与社会协作。', acknowledgePermanent: true });
    if (policyWindow(original, factionId) !== null) {
      const choices = policyComparison(stage.draft, factionId).filter(option => option.allowed);
      const value = (option: typeof choices[number]) => Math.min(50, option.net.food) + option.net.energy * 0.35 + option.net.minerals * 0.65 + option.effectiveUnityChange * 4 + (option.choice === 'utopia' && original.config.maxRounds - original.round >= 8 && !Object.values(faction().shortages).some(Boolean) ? 35 : 0);
      const best = choices.sort((first, second) => value(second) - value(first))[0];
      act('choose_policy', { policy: best.choice });
    }
  }
  if (!balancedRules(original) && policyWindow(original, factionId) !== null) act('choose_policy', { policy: !faction().faith && (faction().unity < 4500 || original.config.factionIds.indexOf(factionId) % 2 === 0) ? 'utopia' : 'balanced' });
  const candidate = original.systems.filter(system => faction().surveyed.includes(system.id)).flatMap(system => system.planets).find(planet => planet.holyCandidate);
  if (!balancedRules(original) && candidate && !faction().faith && original.config.factionIds.indexOf(factionId) % 2 === 1) act('establish_religion', { planetId: candidate.id, name: `${faction().name}星海教`, doctrine: '守护星海圣地，保障居民供给；战争必须有明确目标。', acknowledgePermanent: true });
  const faith = faction().faith;
  if (faith?.dispute) act('respond_dispute', { response: faction().resources.food > units(500) ? 'reconcile' : 'reform', warId: null, systemId: null });
  if (faith) for (const system of owned()) for (const planet of system.planets.filter(planet => planet.holyCandidate && planet.population && !faith.sites.some(site => site.planetId === planet.id && site.consecratedDay !== undefined))) if (faction().resources.minerals > units(700)) act('consecrate', { planetId: planet.id });

  const knownFleets = new Map<string, { ownerId: string; ships: { hull: number }[] }>();
  if (revised(original)) {
    const intel = observation(original, factionId, null, false);
    for (const system of intel.systems) for (const fleet of system.fleets) knownFleets.set(fleet.id, fleet);
    for (const transit of intel.militaryTransits) knownFleets.set(transit.fleet.id, transit.fleet);
  }
  for (const relation of Object.values(original.relations).filter(relation => relation.factions.includes(factionId))) {
    const target = relation.factions.find(id => id !== factionId)!;
    if (original.factions[target].eliminatedDay !== undefined) continue;
    const ownPower = original.fleets.filter(fleet => fleet.ownerId === factionId).reduce((sum, fleet) => sum + fleetPower(fleet), 0);
    const enemyKnownPower = [...knownFleets.values()].filter(fleet => fleet.ownerId === target).reduce((sum, fleet) => sum + fleet.ships.reduce((total, ship) => total + ship.hull, 0), 0);
    const canRiskConquest = ownPower >= Math.max(120, enemyKnownPower * ESCALATION.suggestedPowerRatio) && original.config.maxRounds - original.round > 15 && (modern(original) || faction().policy?.choice !== 'utopia') && !Object.values(faction().shortages).some(Boolean);
    if(modern(original)&&route(stage.draft,factionId)==='secular'&&canRiskConquest&&borders(original,factionId,target)&&original.config.maxRounds-original.round>20) act('establish_civilization',{civilization:'militarist',acknowledgePermanent:true,...(responsible(original)?{welfare:'comfortable'}:{})});
    if (revised(original) && route(stage.draft,factionId)!=='utopia' && relation.status === 'peace' && !conquestFor(stage.draft, factionId) && canRiskConquest && borders(original, factionId, target) && faction().resources.minerals >= units(1000) && faction().resources.food >= units(300) && faction().unity >= 4000 && original.round % 3 === 0) act('prepare_conquest', { factionId: target, reason: '根据已知边境军情与经济储备公开准备征服，接受情报误差风险' });
    if (relation.status === 'contact' && !relation.confirmed.includes(factionId)) act('confirm_contact', { factionId: target });
    else if (relation.status === 'war' && relation.offers[target] && relation.offers[target].createdRound < original.round) act('accept_peace', { factionId: target });
    else if (relation.status === 'war') {
      const war = activeWar(original, factionId, target);
      if (war?.goals[factionId].length && war.goals[factionId].every(goal => !goal.invalid && goal.heldDays >= 200)) act('enforce_peace', { factionId: target });
      else if (original.round % 20 === 0 && !relation.offers[factionId]) act('propose_peace', { factionId: target });
    } else if (relation.status === 'peace' && (!relation.pactUntil||relation.pactUntil<=original.day) && original.round > 10 && (responsible(original)||original.round % 3 === 0)) {
      const goal = Object.values(faction().intel).map(intel => intel.system).find(system => system.ownerId === target && system.base && system.neighbors.some(id => owned().some(own => own.id === id)));
      const grievance = warReasons(original, factionId).find(grievance => grievance.target === target && grievance.usable && grievance.availableDay <= original.day);
      const rescue=responsible(original)&&route(stage.draft,factionId)==='utopia'?decisionComparison(stage.draft,factionId,false).wars.find(w=>w.target===target)?.options.find(o=>o.warType==='humanitarian'&&o.allowed):undefined;
      if(rescue&&canRiskConquest)act('declare_war',{factionId:target,warType:'humanitarian',systemIds:rescue.systemIds,grievanceId:rescue.grievanceId,reason:'关注未解除，依据已知目标和军情采取民生救援'});
      else if (grievance && (modern(original) || faction().policy?.choice !== 'utopia') && (!revised(original) || canRiskConquest)) act('declare_war', { factionId: target, warType: 'total', systemIds: [], reason: '依据现存重大理由发动战争', grievanceId: grievance.id });
      else if (goal && (!revised(original) || !conquestFor(stage.draft, factionId))) {
        const claimed = original.claims?.some(claim => claim.factionId === factionId && claim.systemId === goal.id && claim.createdRound < original.round);
        const warType = faith && goal.planets.some(planet => planet.population) ? 'missionary' : claimed ? 'claim' : 'limited';
        if (!claimed && !faith && original.round % 6 === 0) act('create_claim', { systemId: goal.id });
        else act('declare_war', { factionId: target, warType, systemIds: [goal.id], reason: '边境战略目标', grievanceId: null });
      }
    }
  }

  for (const planet of colonies()) {
    if (industrial(original)) {
      const system = stage.draft.systems.find(s=>s.planets.some(p=>p.id===planet.id))!;
      if (planet.structures.some(s=>s.type==='shipyard') && planet.priorities?.shipyard !== 4) act('set_jobs',{planetId:planet.id,structureType:'shipyard',priority:4});
      const foundryPriority = (faction().resources.alloys ?? 0) < units(200) && faction().resources.minerals > units(200) ? 4 : 2;
      if (planet.population >= 4 && (planet.priorities?.foundry ?? 2) !== foundryPriority) act('set_jobs',{planetId:planet.id,structureType:'foundry',priority:foundryPriority});
      if (system.projects.some(p=>p.planetId===planet.id && (p.kind==='building'||p.kind==='expansion'))) continue;
      const purpose=decisionBalanced(original)?resourcePurposes(stage.draft,factionId):null;
      const pendingNet=(resource:string)=>purpose?.resources.find(r=>r.resource===resource)?.afterQueuedNetPer100;
      const foodWeight = faction().lastIncome.food < units(5) || faction().resources.food < units(200) ? 4 : purpose&&(pendingNet('food')??0)>=0?0:.1;
      const energyWeight = faction().lastIncome.energy < units(10) || faction().resources.energy < units(200) ? 3 : purpose&&(pendingNet('energy')??0)>=0?0:.1;
      const alloyWeight = (faction().resources.alloys ?? 0) < units(200) ? 4 : purpose&&(pendingNet('minerals')??0)>(pendingNet('alloys')??0)?3:.5;
      const mineralWeight=purpose?.reserveScoreRemaining===0&&(pendingNet('minerals')??0)>2*(pendingNet('alloys')??0)? .15 : 1;
      const available = industryPlanet(planet, stage.draft.day);
      const options = constructionOptions(stage.draft, factionId, planet.id).filter(o=>o.allowed);
      const value = (o: typeof options[number]) => {
        if (o.type==='wait') return 0;
        let result = o.net.food*foodWeight + o.net.energy*energyWeight + o.net.minerals*mineralWeight + o.net.alloys*alloyWeight + o.unity*(faction().unity<8500 ? 3 : .2);
        if (o.type==='shipyard' && o.operation>0 && (faction().resources.alloys ?? 0)>units(150) && !colonies().some(p=>support(p,'shipyard',stage.draft.day)>0)) result += 25;
        if (o.type==='housing' && planet.population>=available.populationCap-1 && original.config.maxRounds-original.round>15) result += 15;
        if (o.type==='hospital' && original.config.maxRounds-original.round>25 && o.operation>0 && planet.population<available.populationCap) result += 10;
        if (o.type==='lrs' && o.operation>0 && system.neighbors.some(id=>stage.draft.factions[factionId].militaryIntel?.[id]?.ownerId && stage.draft.factions[factionId].militaryIntel?.[id]?.ownerId!==factionId)) result += 12;
        return result - (o.mineralCost+2*o.alloyCost)/100;
      };
      options.sort((a,b)=>value(b)-value(a)||a.type.localeCompare(b.type));
      if (options[0]?.type !== 'wait' && value(options[0])>0) act('build_structure',{planetId:planet.id,structureType:options[0].type});
      else if (available.population>available.employed && faction().resources.minerals>units(1000)) {
        if (planet.population>=8 && available.groundSlots<12 && planet.structures.filter(s=>!['solar','shipyard','lrs','solar_hub','drydock','habitat','maintenance'].includes(s.type)).length>=available.groundSlots) act('expand_slots',{planetId:planet.id,slot:'ground'});
      }
      continue;
    }
    if (faction().resources.minerals < units(120)) break;
    let type: StructureType | null = null;
    if ((faction().lastIncome.food < units(5) || faction().resources.food < units(140)) && !pending(planet.id, 'farm')) type = 'farm';
    else if ((faction().lastIncome.energy < units(10) || faction().resources.energy < units(140)) && !pending(planet.id, 'solar')) type = 'solar';
    else if (!planet.structures.some(structure => structure.type === 'sanatorium') && !pending(planet.id, 'sanatorium') && faction().resources.minerals > units(350)) type = 'sanatorium';
    else if (planet.structures.filter(structure => structure.type === 'mine').length < 4 && !pending(planet.id, 'mine')) type = 'mine';
    if (type) act('build_structure', { planetId: planet.id, structureType: type });
  }

  for (const system of stage.draft.systems) {
    if (stage.actions.length > (governed(original)?actionLimit(original)-1:12)) break;
    const intel=faction().intel[system.id],military=faction().militaryIntel?.[system.id];
    const known=responsible(original)?military&&(military.day>=(intel?.day??-1))?military:intel?.system:system;
    if (!known?.ownerId && faction().surveyed.includes(system.id) && system.neighbors.some(neighbor => owned().some(candidate => candidate.id === neighbor)) && !system.projects.some(project => project.kind === 'base'&&(!responsible(original)||project.ownerId===factionId)) && faction().resources.minerals >= units(320)) act('build_starbase', { systemId: system.id });
  }
  for (const system of stage.draft.systems) {
    const surveys = stage.draft.systems.flatMap(candidate => candidate.projects).filter(project => project.kind === 'survey' && project.ownerId === factionId);
    if (surveys.length >= 2) break;
    if (!faction().surveyed.includes(system.id) && !system.projects.some(project => project.ownerId === factionId && project.kind === 'survey') && system.neighbors.some(neighbor => owned().some(candidate => candidate.id === neighbor)) && faction().resources.minerals >= units(100)) act('survey_system', { systemId: system.id });
  }

  for (const system of owned()) {
    if (!industrial(original) && faction().resources.minerals > units(1000) && !system.planets.some(planet => planet.structures.some(structure => structure.type === 'lrs')) && !system.projects.some(project => project.structureType === 'lrs')) {
      const colony = system.planets.find(planet => planet.ownerId === factionId);
      if (colony) act('build_structure', { planetId: colony.id, structureType: 'lrs' });
    }
    if (faction().resources.minerals < units(500) || faction().resources.food < units(200)) break;
    const target = system.planets.find(planet => !planet.ownerId && !system.projects.some(project => project.kind === 'colonize' && project.planetId === planet.id));
    if (target) act('colonize_planet', { planetId: target.id });
  }

  for (const planet of colonies()) {
    const system = stage.draft.systems.find(candidate => candidate.planets.some(candidatePlanet => candidatePlanet.id === planet.id))!;
    if (!planet.structures.some(structure => structure.type === 'shipyard')) {
      if (!industrial(original) && faction().resources.minerals > units(900) && !pending(planet.id, 'shipyard')) act('build_structure', { planetId: planet.id, structureType: 'shipyard' });
      continue;
    }
    if (industrial(original) && support(planet, 'shipyard', stage.draft.day) <= 0) continue;
    const queued = system.projects.filter(project => project.kind === 'ship' && project.planetId === planet.id).length;
    if (queued < 3 && faction().resources.minerals >= units(240)) {
      const shipType = faction().resources.minerals > units(800) ? 'cruiser' : 'destroyer';
      const material = industrial(original) ? shipMaterials(shipType) : { minerals: units(SHIPS[shipType].minerals), alloys: 0 };
      const count = Math.min(4 - queued, Math.floor((faction().resources.minerals - units(120)) / material.minerals), material.alloys ? Math.floor((faction().resources.alloys ?? 0) / material.alloys) : 99);
      if (count > 0) act('queue_ships', { planetId: planet.id, shipType, count });
    }
  }

  for (const system of owned()) {
    const stationary = stage.draft.fleets.filter(fleet => fleet.ownerId === factionId && fleet.systemId === system.id && !fleet.order);
    for (const fleet of stationary) {
      const nearby = stationary.filter(other => other.id !== fleet.id && stage.draft.fleets.some(current => current.id === other.id) && distance(fleet.position, other.position) <= 20);
      if (nearby.length && stage.draft.fleets.some(current => current.id === fleet.id)) act('merge_fleets', { fleetIds: [fleet.id, ...nearby.slice(0, 19).map(other => other.id)] });
    }
  }

  for (const fleet of [...stage.draft.fleets]) {
    if (fleet.ownerId !== factionId || !fleet.systemId || fleet.order || fleet.withdrawal || fleetPower(fleet) < 100 || stage.actions.length > (governed(original)?actionLimit(original)-1:20)) continue;
    const candidates = stage.draft.systems.filter(system => system.id !== fleet.systemId && !owned().some(candidate => candidate.id === system.id));
    const enemyKnown = candidates.filter(system => faction().intel[system.id]?.system.ownerId && faction().intel[system.id].system.ownerId !== factionId);
    const hostile = enemyKnown.filter(system => canFight(relationship(stage.draft, factionId, controller(faction().intel[system.id].system)!)));
    const targets = hostile.length ? hostile : candidates.filter(system => !faction().intel[system.id]?.system.ownerId);
    targets.sort((first, second) => (shortestPath(stage.draft.systems, fleet.systemId!, first.id)?.length ?? 1000) - (shortestPath(stage.draft.systems, fleet.systemId!, second.id)?.length ?? 1000) || first.id.localeCompare(second.id));
    if (targets[0]) act('move_fleet', { fleetId: fleet.id, systemId: targets[0].id, x: null, y: null, targetFleetId: null });
  }
  stage.execute('end_turn', { summary: `脚本演示：稳固资源供应，探索相邻星系，建立基地与殖民地，集中舰队向外推进。本轮提交${stage.actions.length}条命令。` });
  return { actions: stage.actions, summary: stage.summary, trace: stage.trace, metrics: { ...emptyMetrics(), durationMs: performance.now() - started, reportedModel: 'scripted' } };
}
