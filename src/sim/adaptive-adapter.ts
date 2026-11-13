import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ADAPTIVE } from '../shared/adaptive.js';
import { actionLimit, V53, governanceView } from '../shared/governance.js';
import { policyComparison } from '../shared/comparison.js';
import { constructionView } from '../shared/construction.js';
import { RULES } from '../shared/rules.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import type { Immutable, ScriptCandidate, ScriptObservation, ScriptPlanning, ScriptPreview } from './adaptive-types.js';
import { planAdaptive } from './adaptive-planner.js';
import { scriptKnowledge } from './adaptive-knowledge.js';
import { candidateFacts } from './adaptive-candidates.js';
import { StagingArea } from './actions.js';
import { emptyMetrics } from './bot.js';
import { economicForecast } from './forecast.js';
import { constructionOptions } from './industry.js';
import { adaptiveResourceWeights } from './adaptive-economics.js';
import { support } from '../shared/industry.js';

export function freezeInput<T>(value:T):Immutable<T> {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freezeInput(child);}
  return value as Immutable<T>;
}

export function validateScriptPlan(world:GameState,actor:string,actions:readonly Action[]) {
  const stage=new StagingArea(world,actor);
  for(let index=0;index<actions.length;index++) {
    const action=actions[index], result=stage.execute(action.type,action.args);
    if(!result.ok)return {ok:false,index,reason:result.error??'本方已知条件不满足',stage};
  }
  return {ok:true,index:-1,reason:'',stage};
}

export function adaptiveContext(original:GameState,actor:string) {
  const world=scriptKnowledge(original,actor);
  const generated=candidateFacts(world,actor);
  const input:ScriptObservation={actor,day:world.day,round:world.round,remainingDays:(world.config.maxRounds-world.round)*RULES.daysPerRound,actionLimit:actionLimit(world),...generated};
  const goal=original.factions[actor].scriptMemory?.goal;
  if(goal) {
    const system=world.systems.find(system=>system.id===goal.target||system.planets.some(planet=>planet.id===goal.target));
    const planet=system?.planets.find(planet=>planet.id===goal.target);
    const projects=system?.projects.filter(project=>project.ownerId===actor&&(project.planetId===goal.target||system.id===goal.target)).map(project=>({id:project.id,progress:project.progress}));
    const complete=goal.kind==='base'?system?.ownerId===actor:goal.kind==='colonize'?planet?.ownerId===actor:goal.kind==='civilization'?world.factions[actor].civilization?.choice!=='secular':goal.kind==='scout'?world.factions[actor].militaryIntel?.[goal.target]?.day===world.day:false;
    const facts={owner:system?.ownerId,population:planet?.population,projects,fleets:world.fleets.filter(fleet=>fleet.ownerId===actor&&(fleet.systemId===goal.target||fleet.order?.systemId===goal.target)).map(fleet=>({id:fleet.id,system:fleet.systemId,transit:fleet.transit,position:fleet.position})),route:world.factions[actor].civilization?.choice};
    input.goalStatus={valid:goal.deadline>world.day&&!(goal.kind==='base'&&system?.ownerId&&system.ownerId!==actor),completed:!!complete,progress:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),reason:'依照本方实际领土、队列进度和舰队位置更新'};
  }
  return {world,input:freezeInput(input)};
}

export async function adaptiveDecision(original:GameState,actor:string,signal?:AbortSignal,options: {validate?:typeof validateScriptPlan;inputAudit?:(input:Immutable<ScriptObservation>)=>Promise<void>}={}):Promise<Decision> {
  if(original.rulesRevision!==ADAPTIVE.revision)throw new Error('adaptive-v1 仅支持5.4；旧局请保留 legacy');
  const started=performance.now();
  const checkpoint=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));if(signal?.aborted)throw new Error('比赛已暂停');};
  await checkpoint();
  const {world,input}=adaptiveContext(original,actor);
  await checkpoint();
  if(options.inputAudit)await options.inputAudit(input);
  const remaining=input.remainingDays, safety=Math.min(ADAPTIVE.safetyDays,remaining);
  const horizons=[...new Set([safety,...ADAPTIVE.horizons.map(days=>Math.min(days,remaining))])];
  const stages=new Map<string,ReturnType<typeof validateScriptPlan>>();
  const stageFor=(actions:Immutable<Action[]>)=>{
    const key=JSON.stringify(actions);let cached=stages.get(key);
    if(!cached){cached=validateScriptPlan(world,actor,structuredClone(actions) as Action[]);stages.set(key,cached);}
    return cached;
  };
  const forecastCache=new Map<string,ReturnType<typeof economicForecast>>();
  const priceCache=new WeakMap<GameState,Record<string,number>>();
  const utility=(net:Record<string,number>,_before:ReturnType<typeof policyComparison>[number],state:GameState)=>{
    let weights=priceCache.get(state);if(!weights){weights=adaptiveResourceWeights(state,actor);priceCache.set(state,weights);}
    return Object.entries(net).reduce((total,[key,value])=>total+value*weights![key],0);
  };
  const api:ScriptPlanning={yield:checkpoint,preview:(prefix,candidate,detailed):ScriptPreview=>{
    const before=stageFor(prefix), combined=[...prefix,...candidate?.actions??[]];
    const attempt=stageFor(combined);
    if(!attempt.ok)return {ok:false,reason:attempt.reason,actionCount:0,value:0,risk:0};
    const state=attempt.stage.draft, faction=state.factions[actor];
    const current=policyComparison(state,actor,[faction.policy?.choice??'none'])[0];
    const prior=policyComparison(before.stage.draft,actor,[before.stage.draft.factions[actor].policy?.choice??'none'])[0];
    let value=candidate?.value??0;
    if(candidate&&['jobs','status','welfare','policy'].includes(candidate.kind)) {
      value=utility(Object.fromEntries(Object.entries(current.net).map(([key,amount])=>[key,amount-prior.net[key as keyof typeof prior.net]])),prior,before.stage.draft)+(current.effectiveUnityChange-prior.effectiveUnityChange)*ADAPTIVE.unityValue;
      if(candidate.kind==='welfare')value+=governanceView(state,actor).rawSocial*(V53.treatment[faction.welfare!.choice]-V53.treatment[before.stage.draft.factions[actor].welfare!.choice])*Math.min(1,remaining/720);
      if(candidate.kind==='status'&&candidate.actions[0].args.sealed===false) {
        const restored=structuredClone(state), planet=restored.systems.flatMap(system=>system.planets).find(planet=>planet.id===candidate.target);
        const building=planet?.structures.find(building=>building.id===candidate.actions[0].args.structureId);
        if(building){delete building.restartUntil;const eventual=policyComparison(restored,actor,[faction.policy?.choice??'none'])[0];value=utility(Object.fromEntries(Object.entries(eventual.net).map(([key,amount])=>[key,amount-prior.net[key as keyof typeof prior.net]])),prior,before.stage.draft);
          if(building.type==='shipyard'&&support({...planet!,operation:undefined},'shipyard',restored.day)>0&&(eventual.net.alloys>0||(faction.resources.alloys??0)>0)&&remaining>RULES.daysPerRound)value+=ADAPTIVE.capacityValue;
        }
      }
      if(candidate.kind==='jobs'&&candidate.actions[0].args.structureType==='shipyard') {
        const planet=state.systems.flatMap(system=>system.planets).find(planet=>planet.id===candidate.target)!;
        const old=before.stage.draft.systems.flatMap(system=>system.planets).find(planet=>planet.id===candidate.target)!;
        const gain=support({...planet,operation:undefined},'shipyard',state.day)-support({...old,operation:undefined},'shipyard',state.day);
        if(current.net.alloys>0||(faction.resources.alloys??0)>0)value+=ADAPTIVE.capacityValue*gain;
      }
    }
    if(candidate?.kind==='build') {
      const option=constructionOptions(before.stage.draft,actor,candidate.target).find(option=>option.type===candidate.actions[0].args.structureType);
      if(!option?.allowed||option.operation===0&&option.jobs>0)return {ok:false,reason:'已有及在建岗位挤占后不能运营新增设施',actionCount:0,value:0,risk:0};
      if(option.net.alloys<=0&&candidate.actions[0].args.structureType==='foundry')value=0;
    }
    if(candidate&&['build','ships'].includes(candidate.kind)) {
      const system=state.systems.find(system=>system.planets.some(planet=>planet.id===candidate.target))!;
      const planet=system.planets.find(planet=>planet.id===candidate.target)!;
      const previous=new Set(before.stage.draft.systems.flatMap(system=>system.projects).map(project=>project.id));
      const dates=constructionView(state,system,planet).queues.flatMap(queue=>queue.projects).filter(project=>!previous.has(project.id));
      if(dates.some(project=>project.estimatedCompleteDay===null||project.estimatedCompleteDay>world.day+remaining))return {ok:false,reason:'当前岗位及施工线无法在终局前完成订单',actionCount:0,value:0,risk:0};
    }
    let risk=Object.entries(current.net).filter(([key])=>key!=='alloys').reduce((total,[key,net])=>total+Math.max(0,-((faction.resources[key as 'food']??0)/1000+net*safety/100)),0);
    let projection:ReturnType<typeof economicForecast>|undefined;
    if(candidate&&value<=0&&candidate.priority<2)return {ok:true,reason:'净收益不优于等待',actionCount:attempt.stage.actions.length,risk:Number.MAX_SAFE_INTEGER,value};
    if(detailed) {
      const key=JSON.stringify(combined);projection=forecastCache.get(key);
      if(!projection){projection=economicForecast(state,actor,horizons);forecastCache.set(key,projection);}
      const near=projection.horizons[0];
      risk=(near?.shortageDays??0)*ADAPTIVE.shortagePenalty+(near?.unpaidDays??0)*ADAPTIVE.unpaidPenalty;
    }
    return {ok:true,reason:'',actionCount:attempt.stage.actions.length,risk,value,projection};
  }};
  const plan=await planAdaptive(input,freezeInput(structuredClone(original.factions[actor].scriptMemory)),api);
  const validator=options.validate??validateScriptPlan;
  let actions=plan.actions;
  for(let attempt=1;attempt<=ADAPTIVE.attempts;attempt++) {
    await checkpoint();
    const result=validator(world,actor,actions);
    plan.report.validations=attempt;
    if(result.ok) {
      const accepted=JSON.stringify(actions);
      plan.report.selected=plan.report.selected.filter(item=>item.actions.every(action=>accepted.includes(JSON.stringify(action))));
      if(attempt>1&&plan.memory.goal&&!plan.report.selected.some(item=>item.id===plan.memory.goal!.id))plan.memory.goal=null;
      const summary=plan.report.selected.length?`adaptive-v1：${plan.report.selected.slice(0,5).map(item=>item.label).join('；')}。已接受${result.stage.actions.length}条实际动作；模型请求0。`:plan.summary;
      return {actions:result.stage.actions,summary,trace:result.stage.trace,scriptMemory:plan.memory,scriptReport:plan.report,metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v1'}};
    }
    plan.report.rejected.push({attempt,index:result.index,reason:result.reason});
    if(attempt===ADAPTIVE.attempts)throw new Error('adaptive-v1 三次完整计划校验失败，整轮未提交：'+result.reason);
    const failed=actions[result.index];
    const candidate=input.candidates.find(candidate=>candidate.actions.some(action=>JSON.stringify(action)===JSON.stringify(failed)));
    if(candidate)plan.memory.failures.push({key:candidate.id,fingerprint:candidate.fingerprint,round:world.round,reason:result.reason});
    const first=candidate?actions.findIndex(action=>JSON.stringify(action)===JSON.stringify(candidate.actions[0])):result.index;
    actions=actions.slice(0,Math.max(0,first));
    if(!actions.length)throw new Error('adaptive-v1 修正后没有可提交计划，整轮暂停：'+result.reason);
  }
  throw new Error('adaptive-v1 未完成原子校验');
}

export function commitScriptMemory(state:GameState,decisions:Record<string,Decision>) {
  for(const [actor,decision] of Object.entries(decisions)) {
    if(!decision.scriptMemory)continue;
    const memory=structuredClone(decision.scriptMemory);
    const alive=new Set(state.fleets.filter(fleet=>fleet.ownerId===actor).map(fleet=>fleet.id));
    memory.tasks=memory.tasks.filter(task=>alive.has(task.fleetId)).map(task=>{
      const fleet=state.fleets.find(fleet=>fleet.id===task.fleetId)!;
      return {...task,role:fleet.systemId===task.target&&!fleet.order?'hold':task.role};
    });
    for(const event of state.events.filter(event=>event.round===state.round&&event.type==='order'&&event.audience.includes(actor))) {
      const details=event.details as {factionId?:string;accepted?:boolean;action?:Action}|undefined;
      if(details?.factionId!==actor||details.accepted!==false||!details.action)continue;
      const selected=decision.scriptReport?.selected.find(item=>item.actions.some(action=>JSON.stringify(action)===JSON.stringify(details.action)));
      if(selected)memory.failures.push({key:selected.id,fingerprint:selected.fingerprint,round:state.round,reason:'共同结算未执行；等待对应本方事实或情报更新'});
    }
    memory.failures=memory.failures.slice(-64);
    state.factions[actor].scriptMemory=memory;
  }
}
