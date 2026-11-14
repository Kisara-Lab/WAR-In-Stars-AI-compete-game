import { ADAPTIVE, ADAPTIVE_V3 as CONFIG } from '../shared/adaptive.js';
import { policyComparison } from '../shared/comparison.js';
import { constructionView } from '../shared/construction.js';
import { industryPlanet, LABOR, shipMaterials, support, reserveScore } from '../shared/industry.js';
import { RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import { scoreBreakdown } from '../shared/scoring.js';
import { controller } from '../shared/v4.js';
import type { GameState } from '../shared/types.js';
import { sensorCoverage } from './adaptive-v2-values.js';

export interface V3Value { score:number; economy:number; functional:number; net:Record<string,number>; uses:Record<string,number> }
export type V3Coverage = Record<string,{systemId:string;day:number|null;value:number}[]>;

export function v3PositionValue(state:GameState,actor:string,endDay:number,coverage:V3Coverage={}) : V3Value {
  const own=state.factions[actor],days=Math.max(0,Math.min(CONFIG.operatingHorizon,endDay-state.day));
  const quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const uses:Record<string,number>={energy:quote.upkeep.energy*days/100,food:quote.upkeep.food*days/100,minerals:quote.upkeep.minerals*days/100,alloys:0};
  const covered=new Map<string,number>();
  let functional=0,freeShipSlots=0;
  for(const system of state.systems.filter(system=>system.ownerId===actor&&controller(system)===actor))for(const source of system.planets.filter(planet=>planet.ownerId===actor)) {
    const planet={...source,operation:undefined},industry=industryPlanet(planet,state.day);
    const queue=constructionView(state,system,planet),supplied=!own.shortages.energy&&!own.shortages.minerals;
    const shipRate=support(planet,'shipyard',state.day)*(1+.25*support(planet,'drydock',state.day));
    const queued=queue.queues.find(row=>row.slot==='ship')!.projects;
    const production=(.5+own.unity/10000)*.5**Object.values(own.shortages).filter(Boolean).length;
    const shipSlots=supplied?Math.max(0,Math.floor(days/SHIPS.destroyer.days*shipRate*production*queue.shipLines)-queued.length):0;
    const material=shipMaterials('destroyer');
    uses.minerals+=shipSlots*material.minerals/1000;uses.alloys+=shipSlots*(material.alloys??0)/1000;
    const paidJobs=system.projects.filter(project=>project.planetId===planet.id&&project.structureType).reduce((total,project)=>total+LABOR[project.structureType!].jobs,0);
    const vacancies=Math.max(0,industry.population-industry.employed-paidJobs);
    if(days>RULES.colonizeDays)uses.minerals+=vacancies*Math.max(STRUCTURES.solar.minerals,STRUCTURES.farm.minerals);
    if(supplied&&support(planet,'lrs',state.day)===1)for(const cell of coverage[system.id]??[])covered.set(cell.systemId,cell.value);
    freeShipSlots+=shipSlots;
  }
  const material=shipMaterials('destroyer');
  const usable=Math.min(freeShipSlots,Math.max(0,own.resources.minerals/1000-quote.upkeep.minerals*days/100)/(material.minerals/1000),Math.max(0,(own.resources.alloys??0)/1000)/((material.alloys??0)/1000));
  functional+=Math.max(0,usable)*ADAPTIVE.capacityValue;
  functional+=[...covered.values()].reduce((total,value)=>total+value,0);
  const score=scoreBreakdown(state,actor);
  let economy=0;
  for(const resource of ['energy','food','minerals','alloys'] as const) {
    const stock=(own.resources[resource]??0)/1000,need=Math.max(0,uses[resource]),weight=resource==='alloys'?2:1;
    const available=Math.min(stock,need);
    const capacity=Math.min(Math.max(0,quote.net[resource])*days/100,Math.max(0,need-stock));
    economy+=(available+capacity)*weight*CONFIG.investmentValue+Math.max(0,stock-need)*CONFIG.surplusValue;
  }
  economy-=reserveScore({energy:0,food:0,minerals:Math.min(own.resources.minerals,uses.minerals*1000),alloys:Math.min(own.resources.alloys??0,uses.alloys*1000)});
  return {score:score.total,economy,functional,net:quote.net,uses};
}

export function v3Coverage(state:GameState,actor:string) {
  return Object.fromEntries(state.systems.filter(system=>controller(system)===actor).map(system=>[system.id,sensorCoverage(state,actor,system.id)]));
}

export function v3StaticTimeline(original:GameState,actor:string,days:number,coverage:V3Coverage,valueAt:typeof v3PositionValue=v3PositionValue) {
  const state=structuredClone(original),end=state.day+days,endDay=state.day+(state.config.maxRounds-state.round)*100;
  for(const system of state.systems)for(const planet of system.planets)delete planet.operation;
  const completions=state.systems.flatMap(system=>[...system.planets.filter(planet=>planet.ownerId===actor).flatMap(planet=>constructionView(state,system,planet).queues.flatMap(queue=>queue.projects.map(project=>({id:project.id,day:project.estimatedCompleteDay})))),...system.projects.filter(project=>project.ownerId===actor&&project.kind==='colonize'&&controller(system)===actor).map(project=>({id:project.id,day:state.day+Math.ceil(Math.max(10,project.requiredDays-project.progress/1000)/10)*10}))]).filter(item=>item.day!==null&&item.day<=end).sort((first,second)=>first.day!-second.day!||first.id.localeCompare(second.id));
  let shortageDays=0,unpaidDays=0,lowUnityDays=0,minimumUnity=100;
  const advance=(until:number)=>{
    const duration=until-state.day;if(duration<=0)return;
    const own=state.factions[actor],quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
    const shortage=Math.max(0,...(['energy','food','minerals'] as const).map(resource=>quote.net[resource]<0?duration-(own.resources[resource]/1000)/-quote.net[resource]*100:0));
    shortageDays+=Math.min(duration,Math.ceil(shortage/10)*10);unpaidDays+=Math.min(duration,Math.ceil(shortage/10)*10);
    for(const resource of ['energy','food','minerals','alloys'] as const)own.resources[resource]=Math.max(0,(own.resources[resource]??0)+quote.net[resource]*duration*10);
    const before=own.unity/100,after=Math.max(0,Math.min(100,before+quote.effectiveUnityChange*duration/100));
    lowUnityDays+=before<60&&after<60?duration:before>=60&&after>=60?0:duration*(60-Math.min(before,after))/Math.max(.01,Math.abs(after-before));
    minimumUnity=Math.min(minimumUnity,after);own.unity=Math.round(after*100);state.day=until;
  };
  for(const completion of completions) {
    advance(completion.day!);
    const system=state.systems.find(system=>system.projects.some(project=>project.id===completion.id))!;
    const project=system.projects.find(project=>project.id===completion.id)!,planet=system.planets.find(planet=>planet.id===project.planetId);
    if(project.kind==='building'&&project.structureType&&planet)planet.structures.push({id:project.id,type:project.structureType});
    if(project.kind==='colonize'&&planet&&!planet.ownerId){planet.ownerId=actor;planet.population=2;planet.growthDays=0;}
    if(project.kind==='ship'&&project.shipType&&planet)state.fleets.push({id:project.id,name:project.id,ownerId:actor,systemId:system.id,position:planet.position,order:null,transit:null,ships:[{id:project.id,type:project.shipType,hull:SHIPS[project.shipType].power}]});
    if(project.expansion&&planet){planet.expansions??={ground:0,orbital:false};if(project.expansion==='orbital')planet.expansions.orbital=true;else planet.expansions.ground++;}
    system.projects=system.projects.filter(item=>item.id!==project.id);
    if(planet)delete planet.operation;
  }
  advance(end);
  const value=valueAt(state,actor,endDay,coverage);
  return {...value,shortageDays,unpaidDays,lowUnityDays,minimumUnity,unity:state.factions[actor].unity/100};
}
