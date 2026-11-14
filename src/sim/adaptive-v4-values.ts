import { ADAPTIVE } from '../shared/adaptive.js';
import { ADAPTIVE_V4 as CONFIG } from '../shared/adaptive-v4.js';
import { policyComparison } from '../shared/comparison.js';
import { constructionView } from '../shared/construction.js';
import { support, shipMaterials, reserveScore } from '../shared/industry.js';
import { SHIPS, RULES, BASE } from '../shared/rules.js';
import { controller } from '../shared/v4.js';
import type { GameState } from '../shared/types.js';
import { v3PositionValue, v3Coverage, type V3Coverage } from './adaptive-v3-values.js';

export function coverageV4(state:GameState,actor:string):V3Coverage {
  return Object.fromEntries(Object.entries(v3Coverage(state,actor)).map(([id,cells])=>[id,cells.map(cell=>{
    const system=state.systems.find(system=>system.id===cell.systemId)!;
    const foreign=!!system.ownerId&&system.ownerId!==actor;
    const task=state.factions[actor].scriptMemory?.operation?.targets.includes(cell.systemId)||state.factions[actor].failedOrders?.['build_starbase:'+cell.systemId];
    const stale=cell.day===null||state.day-cell.day>CONFIG.intelDays;
    return {...cell,value:controller(system)===actor?0:(foreign?CONFIG.sensorForeignValue:CONFIG.sensorUnknownValue)+(foreign&&stale?CONFIG.sensorStaleValue:0)+(task?CONFIG.sensorTaskValue:0)};
  })]));
}

/** V4: a free yard is an investment option, not an already built fleet. */
export function positionValueV4(state:GameState,actor:string,endDay:number,coverage:V3Coverage={}) {
  const value=v3PositionValue(state,actor,endDay,coverage),own=state.factions[actor];
  const days=Math.max(0,Math.min(720,endDay-state.day)),quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  let slots=0;
  for(const system of state.systems.filter(system=>system.ownerId===actor&&controller(system)===actor))for(const source of system.planets.filter(planet=>planet.ownerId===actor)) {
    const planet={...source,operation:undefined},queue=constructionView(state,system,planet);
    const rate=support(planet,'shipyard',state.day)*(1+.25*support(planet,'drydock',state.day));
    const productivity=(.5+own.unity/10000)*.5**Object.values(own.shortages).filter(Boolean).length;
    if(!own.shortages.energy&&!own.shortages.minerals)slots+=Math.max(0,Math.floor(days/SHIPS.destroyer.days*rate*productivity*queue.shipLines)-queue.queues.find(row=>row.slot==='ship')!.projects.length);
  }
  const materials=shipMaterials('destroyer');
  const usable=Math.min(slots,Math.max(0,own.resources.minerals/1000-quote.upkeep.minerals*days/100)/(materials.minerals/1000),Math.max(0,(own.resources.alloys??0)/1000)/((materials.alloys??0)/1000));
  value.functional-=Math.max(0,usable)*ADAPTIVE.capacityValue;
  // Budget actual known expansion options, not hidden populations or hypothetical foreign assets.
  if(days>=RULES.colonizeDays)for(const system of state.systems.filter(system=>system.ownerId===actor&&controller(system)===actor))for(const planet of system.planets.filter(planet=>!planet.ownerId&&!system.projects.some(project=>project.planetId===planet.id&&project.kind==='colonize'))) {
    value.uses.minerals+=RULES.colonizeMinerals;value.uses.food+=RULES.colonizeFood;
  }
  if(days>=BASE.days)for(const system of state.systems.filter(system=>!system.ownerId&&own.surveyed.includes(system.id)&&system.neighbors.some(id=>state.systems.some(owned=>owned.id===id&&owned.ownerId===actor))&&!system.projects.some(project=>project.ownerId===actor&&project.kind==='base')))value.uses.minerals+=BASE.minerals;
  value.economy=0;
  for(const resource of ['energy','food','minerals','alloys'] as const) {
    const stock=(own.resources[resource]??0)/1000,need=Math.max(0,value.uses[resource]);
    const available=Math.min(stock,need),capacity=Math.min(Math.max(0,quote.net[resource])*days/100,Math.max(0,need-stock));
    value.economy+=(available+capacity)*(resource==='alloys'?2:1)*CONFIG.investmentValue+Math.max(0,stock-need)*CONFIG.surplusValue;
  }
  value.economy-=reserveScore({energy:0,food:0,minerals:Math.min(own.resources.minerals,value.uses.minerals*1000),alloys:Math.min(own.resources.alloys??0,value.uses.alloys*1000)});
  return value;
}

/** Information has conditional option value; no undiscovered colony is counted as owned. */
export function surveyValueV4(state:GameState,actor:string,systemId:string) {
  const system=state.systems.find(system=>system.id===systemId),own=state.factions[actor];
  if(!system||own.surveyed.includes(systemId)||system.ownerId&&system.ownerId!==actor||system.base&&controller(system)!==actor)return 0;
  const remaining=(state.config.maxRounds-state.round)*100;
  const completion=RULES.surveyDays+BASE.days/Math.max(.5,.5+own.unity/10000);
  if(remaining<=completion)return 0;
  return Math.max(0,100-BASE.minerals*CONFIG.investmentValue)*CONFIG.discoveryOptionWeight*Math.min(1,(remaining-completion)/720);
}
