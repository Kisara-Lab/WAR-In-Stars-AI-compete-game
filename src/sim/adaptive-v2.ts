import { performance } from 'node:perf_hooks';
import { ADAPTIVE_V2 as CONFIG, type ScriptMemory, type ScriptReport } from '../shared/adaptive.js';
import { policyComparison } from '../shared/comparison.js';
import { constructionView } from '../shared/construction.js';
import { V53, governanceView } from '../shared/governance.js';
import { LABOR, industryPlanet } from '../shared/industry.js';
import { STRUCTURES } from '../shared/rules.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import { candidateFacts } from './adaptive-candidates.js';
import { functionalValue, readyPlanet } from './adaptive-v2-values.js';
import { adaptiveResourceWeights } from './adaptive-economics.js';
import { StagingArea } from './actions.js';
import { validateScriptPlan, freezeInput } from './adaptive-adapter.js';
import { emptyMetrics } from './bot.js';
import { economicForecast } from './forecast.js';
import type { ScriptCandidate } from './adaptive-types.js';

export type ForecastRequest=(state:GameState,actor:string,horizons:number[])=>Promise<ReturnType<typeof economicForecast>>;
export interface PlanningHooks {forecast?:ForecastRequest;checkpoint?:()=>Promise<void>;inputAudit?:(input:unknown)=>Promise<void>}

export function forecastInput(state:GameState,actor:string) {
  return {...state,events:[],factions:{[actor]:{...state.factions[actor],intel:{},militaryIntel:{},transitIntel:{},strategies:[],scriptMemory:undefined}},systems:state.systems.filter(system=>system.ownerId===actor||system.controllerId===actor),fleets:state.fleets.filter(fleet=>fleet.ownerId===actor),config:{...state.config,factionIds:[actor]}};
}

export async function adaptiveV2Decision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:PlanningHooks={}):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('adaptive-v2 仅支持5.4');
  const started=performance.now();
  const timings:Record<string,number>={candidateMs:0,copyMs:0,staticMs:0,forecastMs:0,validationMs:0,cacheHits:0,peakHeapMb:0};
  const checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  await checkpoint();
  const generation=performance.now();
  const generated=candidateFacts(world,actor,true);
  timings.candidateMs=performance.now()-generation;
  await hooks.inputAudit?.(freezeInput(structuredClone(generated)));
  const report:ScriptReport={version:'adaptive-v2',candidates:generated.candidates.length,forecasts:0,validations:0,exhausted:generated.truncated,alternatives:[],selected:[],rejected:[],comparisons:generated.comparisons,assumptions:'只使用本方知识；经济冻结控制权，责任和战争为条件情景；短缺风险统一按日计算',projections:[]};
  const memory:ScriptMemory=previous?.version==='adaptive-v2'?structuredClone(previous):{version:'adaptive-v2',goal:null,tasks:[],failures:[]};
  const remaining=(world.config.maxRounds-world.round)*100;
  const horizons=[...new Set([Math.min(300,remaining),Math.min(720,remaining),Math.min(1440,remaining)])];
  const forecast=hooks.forecast??(async(state,actor,days)=>economicForecast(state,actor,days));
  const project=async(state:GameState,id:string)=>{
    report.forecasts++;
    const start=performance.now();
    const result=await forecast(forecastInput(state,actor),actor,horizons);
    timings.forecastMs+=performance.now()-start;
    report.projections!.push({id,horizons:result.horizons});
    return result;
  };
  const riskOf=(result:ReturnType<typeof economicForecast>)=>(result.horizons[0]?.shortageDays??0)*CONFIG.shortagePenalty+(result.horizons[0]?.unpaidDays??0)*CONFIG.unpaidPenalty+Math.max(0,CONFIG.healthUnity-(result.horizons.at(-1)?.unity??100))*CONFIG.unityRiskPerPoint;
  let stage=new StagingArea(world,actor),risk=riskOf(await project(world,'wait'));
  const staticCache=new WeakMap<GameState,{economy:ReturnType<typeof policyComparison>[number];functions:number;weights:Record<string,number>}>();
  const statics=(state:GameState)=>{
    const cached=staticCache.get(state);if(cached){timings.cacheHits++;return cached;}
    const start=performance.now();
    const result={economy:policyComparison(state,actor,[state.factions[actor].policy?.choice??'none'])[0],functions:functionalValue(state,actor).value,weights:adaptiveResourceWeights(state,actor)};
    staticCache.set(state,result);timings.staticMs+=performance.now()-start;return result;
  };
  const estimateRisk=(state:GameState)=>{
    const economy=statics(state).economy;
    let shortageDays=0;
    for(const resource of ['energy','food','minerals'] as const)if(economy.net[resource]<0)shortageDays=Math.max(shortageDays,Math.max(0,horizons[0]-state.factions[actor].resources[resource]/1000/-economy.net[resource]*100));
    const projectedUnity=Math.max(0,state.factions[actor].unity/100+economy.effectiveUnityChange*Math.min(remaining,1440)/100);
    return Math.ceil(shortageDays/10)*10*(CONFIG.shortagePenalty+CONFIG.unpaidPenalty)+Math.max(0,CONFIG.healthUnity-projectedUnity)*CONFIG.unityRiskPerPoint;
  };
  const utility=(candidate:ScriptCandidate,before:GameState,after:GameState)=>{
    if(!['jobs','status','welfare','policy','build'].includes(candidate.kind))return candidate.value;
    const original=statics(before);
    const eventual=structuredClone(after);
    if(candidate.kind==='build') {
      const prior=structuredClone(before);
      for(const state of [prior,eventual])for(const system of state.systems)for(const project of system.projects.filter(project=>project.ownerId===actor&&project.kind==='building'&&project.structureType)) {
        const planet=system.planets.find(planet=>planet.id===project.planetId);if(planet){planet.structures.push({id:project.id,type:project.structureType!});delete planet.operation;}
      }
      const first=statics(prior),last=statics(eventual),type=candidate.actions[0].args.structureType as keyof typeof STRUCTURES;
      const benefit=Object.entries(last.economy.net).reduce((sum,[resource,amount])=>sum+(amount-first.economy.net[resource as 'energy'])*original.weights[resource],0)*Math.max(0,Math.min(remaining,1440)-STRUCTURES[type].days)/100*CONFIG.economicValue;
      return benefit+last.functions-first.functions+(last.economy.effectiveUnityChange-first.economy.effectiveUnityChange)*(before.factions[actor].unity<10000?CONFIG.unityValue:CONFIG.surplusWeight)-(STRUCTURES[type].minerals+2*LABOR[type].alloys)*CONFIG.materialValue;
    }
    for(const system of eventual.systems)for(const planet of system.planets) {
      delete planet.operation;
      for(const structure of planet.structures)if(candidate.actions.some(action=>action.type==='set_structure_status'&&action.args.structureId===structure.id&&action.args.sealed===false))delete structure.restartUntil;
    }
    const next=statics(eventual);
    let value=Object.entries(next.economy.net).reduce((sum,[resource,amount])=>sum+(amount-original.economy.net[resource as 'energy'])*original.weights[resource],0)*Math.min(remaining,720)/100*CONFIG.economicValue;
    value+=next.functions-original.functions+(next.economy.effectiveUnityChange-original.economy.effectiveUnityChange)*CONFIG.unityValue;
    if(candidate.kind==='welfare')value+=governanceView(world,actor).rawSocial*(V53.treatment[after.factions[actor].welfare!.choice]-V53.treatment[before.factions[actor].welfare!.choice]);
    return value;
  };
  const used=new Set<string>(),remainingCandidates=[...generated.candidates];
  const compare=(first:ScriptCandidate,second:ScriptCandidate)=>second.priority-first.priority||second.value-first.value||first.id.localeCompare(second.id,'en');
  remainingCandidates.sort(compare);
  const declined=new Map<string,ScriptReport['alternatives'][number]>();
  const reject=(candidate:ScriptCandidate,reason:string)=>declined.set(candidate.id,{id:candidate.id,label:candidate.label,priority:candidate.priority,value:candidate.value,risk:candidate.risk,reason,evidenceDays:candidate.evidenceDays,selected:false});
  const cache=new Map<string,{stage:StagingArea;value:number;error?:string}>();
  const projections=new Map<string,ReturnType<typeof economicForecast>>();
  let prefix=0;
  const preview=(candidate:ScriptCandidate)=>{
    const key=prefix+candidate.id,cached=cache.get(key);if(cached){timings.cacheHits++;return cached;}
    const start=performance.now(),attempt=new StagingArea(stage.draft,actor);
    attempt.actions=structuredClone(stage.actions);timings.copyMs+=performance.now()-start;
    let error:string|undefined;
    for(const action of candidate.actions){const result=attempt.execute(action.type,action.args);if(!result.ok){error=result.error;break;}}
    if(!error&&candidate.kind==='build') {
      const planet=attempt.draft.systems.flatMap(system=>system.planets).find(planet=>planet.id===candidate.target)!;
      const type=candidate.actions[0].args.structureType as keyof typeof STRUCTURES;
      const future=readyPlanet(planet,attempt.draft.day);
      const projects=attempt.draft.systems.flatMap(system=>system.projects).filter(project=>project.planetId===planet.id&&project.kind==='building'&&project.structureType);
      for(const item of projects)future.structures.push({id:item.id,type:item.structureType!});
      const jobs=industryPlanet(future,attempt.draft.day).buildings.filter(building=>building.type===type);
      if(LABOR[type].jobs&&jobs.some(building=>type==='lrs'?building.operation!==1:building.operation===0))error='在建岗位计入后无法运营';
    }
    if(!error&&['build','ships','expand'].includes(candidate.kind)) {
      const system=attempt.draft.systems.find(system=>system.planets.some(planet=>planet.id===candidate.target))!;
      const planet=system.planets.find(planet=>planet.id===candidate.target)!;
      const old=new Set(stage.draft.systems.flatMap(system=>system.projects).map(project=>project.id));
      if(constructionView(attempt.draft,system,planet).queues.flatMap(queue=>queue.projects).some(project=>!old.has(project.id)&&(project.estimatedCompleteDay===null||project.estimatedCompleteDay>world.day+remaining)))error='当前施工线不能在终局前完成';
    }
    const result={stage:attempt,value:error?0:utility(candidate,stage.draft,attempt.draft),error};
    if(cache.size>=CONFIG.stageCache)cache.delete(cache.keys().next().value!);cache.set(key,result);return result;
  };
  while(remainingCandidates.length&&stage.actions.length<48) {
    await checkpoint();
    const candidate=remainingCandidates.shift()!;
    if(candidate.exclusive.some(key=>used.has(key))){reject(candidate,'用途或任务已分配');continue;}
    if(memory.failures.some(failure=>failure.key===candidate.id&&failure.fingerprint===candidate.fingerprint)){reject(candidate,'相关失败前提未更新');continue;}
    const attempt=preview(candidate);
    if(attempt.error){reject(candidate,attempt.error);continue;}
    if(attempt.value<=0&&candidate.priority<2){reject(candidate,'计入运营和机会成本后不优于等待');continue;}
    let nextRisk=estimateRisk(attempt.stage.draft);
    const cachedProjection=projections.get(prefix+':'+candidate.id);
    if(cachedProjection){timings.cacheHits++;nextRisk=riskOf(cachedProjection);}
    else if(candidate.economic&&report.forecasts<CONFIG.forecasts) {
      const batch=[candidate,...remainingCandidates.filter(item=>item.economic&&!item.exclusive.some(key=>used.has(key))&&item.priority===candidate.priority).slice(0,Math.min(CONFIG.forecastBatch-1,CONFIG.forecasts-report.forecasts-1))];
      const results=await Promise.all(batch.map(async item=>{
        const option=preview(item);
        if(option.error||option.value<=0&&item.priority<2)return null;
        const key=prefix+':'+item.id;
        let result=projections.get(key);
        if(!result){result=await project(option.stage.draft,key);projections.set(key,result);}
        return {id:item.id,result};
      }));
      const projected=results.find(item=>item?.id===candidate.id);if(projected)nextRisk=riskOf(projected.result);
    }
    if(nextRisk>risk&&candidate.priority<3){reject(candidate,'300日短缺风险增加');continue;}
    stage=attempt.stage;risk=nextRisk;prefix++;cache.clear();projections.clear();
    candidate.exclusive.forEach(key=>used.add(key));
    report.selected.push({id:candidate.id,label:candidate.label,actions:candidate.actions,fingerprint:candidate.fingerprint});
    for(const task of candidate.tasks){memory.tasks=memory.tasks.filter(old=>old.fleetId!==task.fleetId);memory.tasks.push(task);}
    if(['war','prepare','claim','scout','civilization','recovery'].includes(candidate.kind)) {
      const prior=memory.goal;
      if(!prior||prior.id===candidate.id||world.round-prior.lastProgressRound>=CONFIG.stalledRounds||candidate.value>prior.value*CONFIG.switchRatio||candidate.priority>=2)memory.goal={id:candidate.id,kind:candidate.kind,target:candidate.target,stage:candidate.kind,deadline:candidate.deadline,value:candidate.value,prerequisites:[candidate.reason],progress:candidate.progress,lastProgressRound:prior?.id===candidate.id&&prior.progress===candidate.progress?prior.lastProgressRound:world.round};
    }
    timings.peakHeapMb=Math.max(timings.peakHeapMb,process.memoryUsage().heapUsed/2**20);
  }
  report.alternatives=[...declined.values()].sort((first,second)=>second.priority-first.priority||second.value-first.value||first.id.localeCompare(second.id,'en')).slice(0,3);
  report.exhausted ||=report.forecasts===CONFIG.forecasts;
  if(memory.goal&&memory.goal.deadline<=world.day)memory.goal=null;
  let actions=stage.actions;
  for(let attempt=1;attempt<=CONFIG.attempts;attempt++) {
    await checkpoint();const start=performance.now();
    const checked=validateScriptPlan(world,actor,actions);timings.validationMs+=performance.now()-start;report.validations=attempt;
    if(checked.ok) {
      report.selected=report.selected.filter(item=>item.actions.every(action=>actions.some(accepted=>JSON.stringify(accepted)===JSON.stringify(action))));
      report.performance=timings;
      return {actions:checked.stage.actions,trace:checked.stage.trace,summary:'adaptive-v2：'+(report.selected.slice(0,5).map(item=>item.label).join('；')||'等待：可知收益不优于保留资源')+'；模型请求0。',scriptMemory:memory,scriptReport:report,metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v2'}};
    }
    report.rejected.push({attempt,index:checked.index,reason:checked.reason});
    if(attempt===CONFIG.attempts||checked.index===0)throw new Error('adaptive-v2 完整计划验证失败，整轮未提交：'+checked.reason);
    actions=actions.slice(0,checked.index);
  }
  throw new Error('adaptive-v2 未完成校验');
}
