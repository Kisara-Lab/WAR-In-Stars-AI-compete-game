import type { GameState } from '../shared/types.js';
import type { PortfolioV415Final, DevelopmentV415Final, ContinuityTaskV415Final } from '../shared/adaptive-v415final.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import type { economicForecast } from './forecast.js';
import { policyComparison } from '../shared/comparison.js';

export function portfolioV415Final(state:GameState,actor:string,projection:ReturnType<typeof economicForecast>,options:DevelopmentV415Final[]):PortfolioV415Final {
  const resources=['energy','food','minerals','alloys'] as const;
  const end=state.day+(state.config.maxRounds-state.round)*100;
  const own=state.factions[actor],quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const points=[{days:0,resources:Object.fromEntries(resources.map(resource=>[resource,(own.resources[resource]??0)/1000]))},...projection.horizons];
  const balance=(day:number,resource:string)=>{
    const elapsed=day-state.day;
    const lower=[...points].reverse().find(point=>point.days<=elapsed)??points[0];
    const upper=points.find(point=>point.days>=elapsed)??points.at(-1)!;
    return lower.resources[resource]+(upper.resources[resource]-lower.resources[resource])*(upper.days===lower.days?0:(elapsed-lower.days)/(upper.days-lower.days));
  };
  const allocations:PortfolioV415Final['allocations']=[],deferred:PortfolioV415Final['deferred']=[];
  const reserved=Object.fromEntries(resources.map(resource=>[resource,0]));
  const systems=new Set<string>();let conditionalValue=0;
  for(const option of options.slice().sort((first,second)=>second.optionValue-first.optionValue||first.id.localeCompare(second.id,'en'))) {
    if(systems.has(option.systemId)&&option.next==='base'){deferred.push({id:option.id,reason:'共享基地由已分配开发链支付，建成后重新评估殖民'});continue;}
    const buffer=Object.fromEntries(resources.map(resource=>[resource,Math.max(0,-quote.net[resource])*3]));
    let startDay:number|undefined;
    for(let day=Math.max(state.day,Math.ceil(option.readyDay/100)*100);day<=Math.min(end,points.at(-1)!.days+state.day);day+=100) {
      const cost=option.cost;
      if(resources.every(resource=>balance(day,resource)-reserved[resource]-buffer[resource]>=(cost[resource]??0))) {startDay=day;break;}
    }
    if(startDay===undefined||option.productiveDay+startDay-option.readyDay>=end){deferred.push({id:option.id,reason:'共享资金不足或完整生产链无法在终局前投产'});continue;}
    for(const resource of resources)reserved[resource]+=option.cost[resource]??0;
    allocations.push({id:option.id,target:option.planetId,startDay,completeDay:option.productiveDay+startDay-option.readyDay,cost:{...option.cost},projects:[...option.projects]});
    systems.add(option.systemId);
    conditionalValue+=option.optionValue*Math.max(0,(end-option.productiveDay-(startDay-option.readyDay))/Math.max(1,end-option.productiveDay));
  }
  return {day:state.day,allocations,deferred,reserved,conditionalValue};
}

export function continuityV415Final(state:GameState,actor:string,memory:ScriptMemory,portfolio:PortfolioV415Final):ContinuityTaskV415Final[] {
  const previous=memory.v415final?.tasks??[],result:ContinuityTaskV415Final[]=[];
  for(const allocation of portfolio.allocations) {
    const planet=state.systems.flatMap(system=>system.planets).find(planet=>planet.id===allocation.target);
    const system=state.systems.find(system=>system.planets.some(planet=>planet.id===allocation.target));
    const evidence=JSON.stringify({owner:planet?.ownerId,population:planet?.population,structures:planet?.structures,projects:system?.projects.filter(project=>project.ownerId===actor&&(project.planetId===allocation.target||project.kind==='base')).map(project=>[project.id,project.progress])});
    const old=previous.find(task=>task.id===allocation.id);
    const lastProgressRound=old&&old.evidence===evidence?old.lastProgressRound:state.round;
    result.push({id:allocation.id,target:allocation.target,kind:'development',createdRound:old?.createdRound??state.round,lastProgressRound,expectedDay:allocation.completeDay,status:state.round-lastProgressRound>=2?'reassess':'active',evidence,next:allocation.startDay>state.day?'等待共享资金与施工前提':'执行已筹资开发步骤',dependencies:allocation.projects});
  }
  for(const old of previous.filter(task=>task.kind==='development'&&!result.some(current=>current.id===task.id))) {
    const planet=state.systems.flatMap(system=>system.planets).find(planet=>planet.id===old.target);
    const complete=planet?.ownerId===actor&&planet.structures.some(structure=>!structure.sealed);
    result.push({...old,status:complete?'complete':'blocked',next:complete?'已投产，继续检查就业与供应':'开发前提变化，重新比较资金、路径和归属'});
  }
  const operation=memory.operation;
  if(operation)result.push({id:operation.id,target:operation.targets[0],kind:'campaign',createdRound:Math.floor(operation.createdDay/100),lastProgressRound:operation.lastProgressRound,expectedDay:operation.deadline,status:operation.stage==='exit'?'exit':state.round-operation.lastProgressRound>=2?'reassess':'active',evidence:operation.progress,next:operation.nextStep,dependencies:[...operation.fleetIds]});
  return result.filter(task=>task.status!=='complete'||state.round-task.lastProgressRound<=2).slice(-64);
}

