import { ADAPTIVE_V2 as CONFIG } from '../shared/adaptive.js';
import { industryPlanet, support } from '../shared/industry.js';
import { STRUCTURES, SHIPS, RULES } from '../shared/rules.js';
import { policyComparison } from '../shared/comparison.js';
import { civilizationEligibility } from '../shared/civilization.js';
import { controller } from '../shared/v4.js';
import { governanceView } from '../shared/governance.js';
import type { GameState, Planet } from '../shared/types.js';
import { adaptiveResourceWeights } from './adaptive-economics.js';
import { applyAction } from './actions.js';
import type { decisionComparison } from './options.js';
import { accessiblePath } from './diplomacy.js';

export function sensorCoverage(state:GameState,actor:string,systemId:string) {
  const reachable=new Set([systemId]);
  for(let hop=0;hop<2;hop++)for(const id of [...reachable])for(const neighbor of state.systems.find(system=>system.id===id)?.neighbors??[])reachable.add(neighbor);
  const own=state.factions[actor];
  return [...reachable].sort().map(id=>{
    const system=state.systems.find(system=>system.id===id)!;
    const day=own.militaryIntel?.[id]?.day??own.intel[id]?.day??null;
    const foreign=!!system.ownerId&&system.ownerId!==actor;
    const task=own.scriptMemory?.tasks.some(task=>task.target===id)??false;
    const value=controller(system)===actor?0:CONFIG.sensorSystemValue+(day===null||state.day-day>CONFIG.intelDays?CONFIG.sensorStaleValue:0)+(foreign?CONFIG.sensorThreatValue:0)+(task?CONFIG.sensorTaskValue:0);
    return {systemId:id,day,value};
  });
}

export function functionalValue(state:GameState,actor:string) {
  const own=state.factions[actor], remaining=(state.config.maxRounds-state.round)*RULES.daysPerRound;
  const sensed=new Map<string,number>();
  let value=0,shipCapacity=0;
  const sensors:{systemId:string;planetId:string;active:boolean;coverage:ReturnType<typeof sensorCoverage>}[]=[];
  for(const system of state.systems.filter(system=>system.ownerId===actor&&controller(system)===actor))for(const planet of system.planets.filter(planet=>planet.ownerId===actor)) {
    const current={...planet,operation:undefined};
    const supplied=!own.shortages.energy&&!own.shortages.minerals;
    const active=support(current,'lrs',state.day)===1&&supplied;
    const coverage=sensorCoverage(state,actor,system.id);
    if(planet.structures.some(building=>building.type==='lrs'))sensors.push({systemId:system.id,planetId:planet.id,active,coverage});
    if(active)for(const item of coverage)sensed.set(item.systemId,item.value);
    const shipJobs=support(current,'shipyard',state.day);
    const queue=system.projects.filter(project=>project.planetId===planet.id&&project.kind==='ship');
    const queuedPower=queue.reduce((sum,project)=>sum+(project.shipType?SHIPS[project.shipType].power:0),0);
    const drydock=support(current,'drydock',state.day);
    if(supplied)shipCapacity+=Math.max(0,Math.min(remaining,CONFIG.responsibilityHorizon)/SHIPS.destroyer.days*shipJobs*(drydock===1?2.5:1+drydock*.25)-queue.length);
    value+=Math.min(CONFIG.capacityValue,queuedPower*CONFIG.currentFleetServiceValue)*shipJobs;
    if(queue.length>1&&supplied)value+=Math.min(CONFIG.capacityValue,queuedPower*CONFIG.currentFleetServiceValue)*shipJobs*(drydock===1?1.25:drydock*.25);
    const detail=industryPlanet(current,state.day);
    if(remaining>CONFIG.minInvestmentDays) {
      const capacity=Math.max(0,detail.populationCap-planet.population);
      const growth=Math.min(capacity,remaining/720*(1+support(current,'hospital',state.day)*.2));
      value+=growth*CONFIG.housingPersonValue;
    }
  }
  value+=[...sensed.values()].reduce((sum,amount)=>sum+amount,0);
  const materials=Math.min((own.resources.alloys??0)/1000/20,own.resources.minerals/1000/20);
  value+=Math.min(materials,shipCapacity)*SHIPS.destroyer.power*CONFIG.futureFleetWeight;
  return {value,sensors,covered:[...sensed.keys()]};
}

export function readyPlanet(planet:Planet,day:number) {
  const copy=structuredClone(planet);delete copy.operation;
  for(const structure of copy.structures)if((structure.restartUntil??0)>day)delete structure.restartUntil;
  return copy;
}

export function routeComparison(state:GameState,actor:string,comparison:ReturnType<typeof decisionComparison>) {
  const own=state.factions[actor],remaining=(state.config.maxRounds-state.round)*100;
  const horizon=Math.min(CONFIG.responsibilityHorizon,remaining),weights=adaptiveResourceWeights(state,actor);
  const baseline=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const paths=comparison.wars.filter(war=>war.options.some(option=>option.allowed)||war.preparation.allowed||war.claims.some(claim=>claim.allowed));
  const accessible=paths.filter(war=>{
    const probe=structuredClone(state),relation=Object.values(probe.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(war.target));
    if(!relation)return false;relation.status='war';
    return war.targetIntel?.some(target=>state.fleets.some(fleet=>fleet.ownerId===actor&&fleet.systemId&&accessiblePath(probe,actor,fleet.systemId,target.systemId)!==null));
  });
  const fleetPower=state.fleets.filter(fleet=>fleet.ownerId===actor).flatMap(fleet=>fleet.ships).reduce((sum,ship)=>sum+SHIPS[ship.type].power,0);
  const candidates=comparison.religion.candidates.filter(candidate=>candidate.allowed);
  const result=[{choice:'secular',allowed:true,blockers:[] as string[],value:0,economy:0,social:0,capability:0,success:0,failure:0,assumption:'继续世俗，保留承诺和征服准备选择'}];
  for(const choice of ['utopia','militarist','theocracy'] as const) {
    const draft=structuredClone(state),faction=draft.factions[actor];
    const eligibility=choice==='theocracy'?{allowed:candidates.length>0,blockers:candidates.length?[]:['没有可独占立教的已知己方候选']}:civilizationEligibility(state,actor,choice);
    faction.civilization={choice,establishedDay:state.day};
    faction.welfare={...faction.welfare!,choice:choice==='utopia'?'utopian':choice==='theocracy'?'church':['comfortable','basic','survival'].includes(own.welfare!.choice)?own.welfare!.choice:'comfortable'};
    delete faction.welfare.last;
    if(choice==='theocracy')faction.faith={name:'比较',doctrine:'只读条件估值',establishedDay:state.day,crisis:0,sites:candidates[0]?[{main:true,planetId:candidates[0].planetId,consecratedDay:state.day+300,lossKeys:[],recoveryKeys:[]}]:[],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
    const quote=policyComparison(draft,actor,[faction.policy?.choice??'none'])[0];
    const secular=structuredClone(state);secular.factions[actor].civilization={choice:'secular',establishedDay:state.day};
    if(choice==='militarist'){secular.factions[actor].welfare={...faction.welfare};delete secular.factions[actor].welfare!.last;}
    const counterfactual=choice==='militarist'?policyComparison(secular,actor,[own.policy?.choice??'none'])[0]:baseline;
    const economy=Object.entries(quote.net).reduce((sum,[resource,amount])=>sum+(amount-counterfactual.net[resource as 'energy'])*weights[resource],0)*horizon/100*CONFIG.economicValue;
    const social=choice==='militarist'?0:governanceView(draft,actor).rawSocial*((choice==='utopia'?1:.85)-(own.welfare?.choice==='utopian'?1:own.welfare?.choice==='welfare'?.9:.8));
    const capability=choice==='militarist'?fleetPower*.1+CONFIG.capacityValue*.15:choice==='utopia'?-Number(paths.some(war=>war.preparation.allowed))*CONFIG.conquestOptionValue:0;
    const terms=Math.floor(Math.max(0,horizon-(choice==='theocracy'?300:0))/720);
    const success=choice==='militarist'?CONFIG.dutyValue:terms*100+(choice==='theocracy'?200:0);
    const actionable=paths.length>0;
    const failure=choice==='utopia'?Math.min(300,(state.social?.concerns.filter(concern=>concern.closedDay===undefined&&concern.known[actor]!==undefined).length??0)*CONFIG.responsibilityRisk):actionable?CONFIG.responsibilityRisk:0;
    const probability=choice==='utopia'?1:accessible.length&&fleetPower>0?1-CONFIG.commitmentRisk:0;
    const cost=choice==='theocracy'?(200+100*weights.food)*CONFIG.materialValue:0;
    result.push({choice,allowed:eligibility.allowed,blockers:eligibility.blockers.map(String),value:economy+social+capability+success*probability-failure*(1-probability)-cost-CONFIG.commitmentOptionCost,economy,social,capability,success,failure,assumption:'军国相对同待遇世俗比较，不把降福利节省记为制度收益；永久承诺扣除保留选择价值。责任成功与失败为条件情景，不保证胜利'});
  }
  return result;
}
