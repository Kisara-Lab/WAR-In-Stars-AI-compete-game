import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ADAPTIVE_V4 as CONFIG, type ReportV4, type RiskV4, type MilitaryOptionV4 } from '../shared/adaptive-v4.js';
import type { ScriptMemory, ScriptReport } from '../shared/adaptive.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import { actionLimit, V53 } from '../shared/governance.js';
import { controller } from '../shared/v4.js';
import { candidateFacts } from './adaptive-candidates.js';
import { StagingArea } from './actions.js';
import { validateScriptPlan } from './adaptive-adapter.js';
import { economicForecast } from './forecast.js';
import { forecastInput } from './adaptive-v2.js';
import type { ForecastScenario } from './forecast-v3.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { planningPreview } from './planning-preview.js';
import { applyStateChanges } from './planning-delta.js';
import { coverageV4 } from './adaptive-v4-values.js';
import { v3FailureDependency } from './adaptive-v3-failures.js';
import { dutyPaths } from './social.js';
import { emptyMetrics } from './bot.js';
import { recoveryCandidatesV4, economicCandidatesV4, quickValueV4, forecastRiskV4, currentRiskV4, emptyRiskV4 } from './adaptive-v4-economy.js';
import { tacticalV4, militaryPlansV4, militaryActionV4, cleanTasksV4, campaignProgressV4, scoreIntervalsV4, type TacticalRequestV4, type MilitaryCandidateV4 } from './adaptive-v4-military.js';

export interface V4Hooks {
  candidates?:(state:GameState,actor:string,limit:number)=>Promise<ReturnType<typeof candidateFacts>>;
  forecast?:(state:GameState,actor:string,horizons:number[],scenario:ForecastScenario)=>Promise<ReturnType<typeof economicForecast>>;
  preview?:(state:GameState,actor:string,actions:Action[],candidate:ScriptCandidate)=>Promise<ReturnType<typeof planningPreview>>;
  tactical?:(state:GameState,request:TacticalRequestV4)=>Promise<MilitaryOptionV4>;
  checkpoint?:()=>Promise<void>;
  inputAudit?:(input:unknown)=>Promise<void>;
}
interface BranchV4 {
  stage:StagingArea; groups:MilitaryCandidateV4[]; risk:RiskV4; value:number;
  verified:boolean; projection?:ReturnType<typeof economicForecast>;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare=(first:BranchV4,second:BranchV4)=>Math.abs(first.risk.value-second.risk.value)>CONFIG.riskTolerance?first.risk.value-second.risk.value:second.value-first.value||first.stage.actions.length-second.stage.actions.length||digest(first.stage.actions).localeCompare(digest(second.stage.actions),'en');
const isDuty=(candidate:ScriptCandidate)=>['aid','reform','recovery','faith','demand','settle'].includes(candidate.kind);
const stageName=(candidate:MilitaryCandidateV4)=>isDuty(candidate)||candidate.priority>=3?'crisis':candidate.military||['peace','defend','withdraw','scout'].includes(candidate.kind)?'military':'economy';

export function explainConstraintsV4(reasons:string[],resources:GameState['factions'][string]['resources']) {
  const constraints:string[]=[];
  if(reasons.some(reason=>/可用资源不足|余额不足/.test(reason)))constraints.push(`资金约束（下单后矿物${(resources.minerals/1000).toFixed(3)}、合金${((resources.alloys??0)/1000).toFixed(3)}；未计随后生产）`);
  if(reasons.some(reason=>/并行探索项目上限|已在探索中|已有殖民项目/.test(reason)))constraints.push('探索或殖民项目等待完工');
  if(reasons.some(reason=>/槽位|岗位|施工线/.test(reason)))constraints.push('岗位、槽位或施工条件限制');
  return constraints.length?constraints.join('；')+'；其余已比较方案无可验证改善':'无正收益';
}

export async function adaptiveV4Decision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:V4Hooks={}):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('adaptive-v4 仅支持5.4');
  const started=performance.now(),profile=world.config.scriptSearchProfile??'standard',budget=CONFIG.profiles[profile];
  const checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  const generate=hooks.candidates??(async(state,actor,limit)=>candidateFacts(state,actor,true,limit,true));
  const forecast=hooks.forecast??(async(state,actor,days,scenario)=>economicForecast(state,actor,days,scenario));
  const preview=hooks.preview??(async(state,actor,actions,candidate)=>planningPreview(state,actor,actions,candidate));
  const tactical=hooks.tactical??(async(state,request)=>tacticalV4(state,request));
  const memory:ScriptMemory=previous?.version==='adaptive-v4'?structuredClone(previous):{version:'adaptive-v4',goal:null,tasks:[],failures:[]};
  cleanTasksV4(world,actor,memory);campaignProgressV4(world,actor,memory);
  const remaining=(world.config.maxRounds-world.round)*100,horizons=[...new Set(CONFIG.horizons.map(days=>Math.min(days,remaining)))].filter(Boolean),coverage=coverageV4(world,actor);
  const report:ScriptReport={version:'adaptive-v4',candidates:0,forecasts:0,validations:0,exhausted:false,alternatives:[],selected:[],rejected:[],projections:[],search:{profile,evaluations:0,depth:0,combinations:[]},assumptions:'本方知识；实际危机缺口与局部战斗情景；敌军未知不是零，情景不代表胜率，计划不代表结算成果。'};
  const scoreIntervals=scoreIntervalsV4(world,actor),ownScore=scoreIntervals[actor].low;
  const otherIntervals=Object.entries(scoreIntervals).filter(([id])=>id!==actor).map(([,interval])=>interval);
  const posture:ReportV4['posture']=otherIntervals.some(interval=>interval.low>ownScore)||remaining<=1440?'contest':otherIntervals.length&&otherIntervals.every(interval=>interval.high!==null&&interval.high<ownScore)?'protect':'balanced';
  const stats:Record<string,number>={candidateMs:0,previewMs:0,forecastMs:0,tacticalMs:0,cacheHits:0,peakRssMb:0};
  const stages:ReportV4['stageBudgets']={};
  for(const [name,share] of Object.entries(CONFIG.shares))stages[name]={evaluations:0,forecasts:0,limit:Math.floor((budget.evaluations-3)*share),forecastLimit:Math.floor((budget.forecasts-2)*share)};
  stages.economy.limit=budget.evaluations-3-stages.crisis.limit-stages.military.limit;
  stages.economy.forecastLimit=budget.forecasts-2-stages.crisis.forecastLimit-stages.military.forecastLimit;
  report.v4={risk:emptyRiskV4(),finalRisk:emptyRiskV4(),posture,military:[],tacticalEvaluations:0,crisisChecked:false,pending:[],stageBudgets:stages,scoreIntervals};
  const pending=new Map<string,{candidate:ScriptCandidate;reason:string;dependency:string}>();
  const denied=new Set<string>(),admitted=new Set<string>(),used=new Set<string>();
  const generatedCache=new WeakMap<GameState,ReturnType<typeof candidateFacts>>();
  const previewCache=new Map<string,BranchV4|null>();
  const comparisonDependency=(branch:BranchV4,candidate:ScriptCandidate)=>digest({prefix:branch.stage.actions,conditions:v3FailureDependency(branch.stage.draft,actor,candidate.actions,'')});
  const decline=(candidate:ScriptCandidate,reason:string,dependency:string)=>{pending.set(candidate.id,{candidate,reason,dependency});denied.add(candidate.id+':'+dependency);};
  const factsFor=async(state:GameState)=>{
    let facts=generatedCache.get(state);if(facts){stats.cacheHits++;return facts;}
    const start=performance.now();facts=await generate(state,actor,Number.MAX_SAFE_INTEGER);stats.candidateMs+=performance.now()-start;generatedCache.set(state,facts);return facts;
  };
  const conditional=(groups:MilitaryCandidateV4[])=>groups.reduce((sum,candidate)=>sum+(candidate.military?candidate.value:['settle','faith','scout','explore','merge','withdraw','contact'].includes(candidate.kind)?candidate.value:0),0);
  const project=async(branch:BranchV4,success=false)=>{
    if(report.forecasts>=budget.forecasts)return;
    const state=branch.stage.draft,own=state.factions[actor];
    const due=state.social?.concerns.filter(concern=>concern.target!==actor&&concern.closedDay===undefined&&concern.known[actor]!==undefined).map(concern=>Math.max(concern.known[actor],own.civilization?.establishedDay??0)+360)??[];
    const scenario:ForecastScenario={version:'v4',actionable:dutyPaths(state,actor).actionable,coverage,endDay:world.day+remaining,...(own.civilization?.choice==='utopia'&&due.length?{rescueDueDay:Math.min(...due)}:{})};
    if(success){const successDay=branch.groups.find(candidate=>candidate.successDay!==undefined)?.successDay;if(successDay===undefined)return;scenario.successDay=successDay;}
    report.forecasts++;
    const input=forecastInput(state,actor);
    input.systems=state.systems.filter(system=>system.ownerId===actor||controller(system)===actor||!system.ownerId&&system.projects.some(project=>project.ownerId===actor&&project.kind==='base'));
    const start=performance.now(),result=await forecast(input,actor,horizons,scenario);stats.forecastMs+=performance.now()-start;
    const id=digest(branch.stage.actions)+(success?':success':':no-success');
    report.projections!.push({id,horizons:result.horizons,trajectory:result.trajectory});
    if(success)return result;
    branch.projection=result;branch.risk=forecastRiskV4(result);branch.verified=true;
    const last=result.horizons.at(-1),value=last?.governance?.value;
    branch.value=(last?.governance?.score??0)+(value?.economy??0)+(value?.functional??0)-(last?.governance?.lowUnityDays??0)*CONFIG.lowUnityDayValue+conditional(branch.groups);
    return result;
  };
  let root:BranchV4={stage:new StagingArea(world,actor),groups:[],risk:emptyRiskV4(),value:0,verified:false};
  await project(root);const baseline=root;
  report.v4.risk=structuredClone(root.risk);
  const initial=await factsFor(world);report.comparisons=initial.comparisons;
  const tacticalStarted=performance.now(),plans=militaryPlansV4(world,actor,initial,memory);
  const representatives=[...new Set(plans.map(plan=>plan.opponent+':'+plan.warType))].map(key=>plans.find(plan=>plan.opponent+':'+plan.warType===key)!);
  const selectedPlans=[...representatives,...plans.filter(plan=>!representatives.includes(plan))].slice(0,CONFIG.tacticalPlans[profile]);
  const evaluated=await Promise.all(selectedPlans.map(option=>tactical(world,{actor,option})));stats.tacticalMs=performance.now()-tacticalStarted;
  report.v4.military=evaluated.sort((first,second)=>second.value-first.value||first.id.localeCompare(second.id));report.v4.tacticalEvaluations=evaluated.length;
  const military=evaluated.map(option=>militaryActionV4(world,actor,option,initial)).filter((candidate):candidate is MilitaryCandidateV4=>!!candidate);
  const old=memory.operation;
  if(old&&old.stage!=='exit') {
    const same=military.find(candidate=>candidate.military?.opponent===old.opponent&&candidate.target===old.targets[0]);
    if(same)for(const candidate of military)if(candidate!==same&&candidate.value<same.value*CONFIG.switchRatio)candidate.value=Math.min(candidate.value,same.value-.001);
  }
  await hooks.inputAudit?.({version:CONFIG.revision,profile,budget,observedDay:world.day,facts:initial.facts,military:report.v4.military});
  const extraction=world.factions[actor].extraction,exit=initial.facts.comparison.emergencyEconomy?.withoutSubsidy;
  if(extraction&&extraction.expiresDay>world.day&&exit)memory.recovery={deadline:extraction.expiresDay,lastCheckedDay:world.day,shortages:{...exit.shortages},welfareFraction:exit.welfareFraction??1,normalNet:exit.resourcesPer100};else delete memory.recovery;
  const safe=(branch:BranchV4)=>{
    const before=world.factions[actor],after=branch.stage.draft.factions[actor];
    const raised=V53.treatment[after.welfare!.choice]>V53.treatment[before.welfare!.choice];
    if(raised&&(!branch.projection||branch.projection.horizons.some((row,index)=>row.shortageDays>baseline.projection!.horizons[index].shortageDays||row.unpaidDays>baseline.projection!.horizons[index].unpaidDays)))return false;
    if(branch.groups.some(group=>group.kind==='civilization')&&(!branch.projection||branch.risk.value>baseline.risk.value+CONFIG.riskTolerance))return false;
    return true;
  };
  const candidatesFor=async(branch:BranchV4,name:string)=>{
    const facts=await factsFor(branch.stage.draft),recovery=recoveryCandidatesV4(branch.stage.draft,actor,facts.candidates,branch.risk);
    const candidates=[...recovery,...military,...economicCandidatesV4(branch.stage.draft,actor,facts.candidates)];
    const unique=[...new Map(candidates.map(candidate=>[candidate.id,candidate])).values()];
    return unique.filter(candidate=>stageName(candidate)===name&&!branch.groups.some(group=>group.id===candidate.id)&&!candidate.exclusive.some(key=>used.has(key))).filter(candidate=>{
      const dependency=comparisonDependency(branch,candidate);
      if(denied.has(candidate.id+':'+dependency))return false;
      if(memory.failures.some(failure=>failure.key===candidate.id&&failure.fingerprint===v3FailureDependency(world,actor,candidate.actions,failure.reason)))return false;
      return candidate.actions.length>0;
    }).sort((first,second)=>second.priority-first.priority||second.value-first.value||first.id.localeCompare(second.id,'en'));
  };
  const previewChild=async(parent:BranchV4,candidate:MilitaryCandidateV4,name:string):Promise<BranchV4|null>=>{
    const key=digest(parent.stage.actions)+':'+candidate.id;
    if(previewCache.has(key)){stats.cacheHits++;return previewCache.get(key)!;}
    if(!admitted.has(candidate.id)&&admitted.size>=budget.candidates)return null;
    if(report.search!.evaluations>=budget.evaluations-3)return null;
    admitted.add(candidate.id);report.candidates=admitted.size;report.search!.evaluations++;stages[name].evaluations++;
    const dependency=comparisonDependency(parent,candidate);
    const start=performance.now(),outcome=await preview(parent.stage.draft,actor,parent.stage.actions,candidate);stats.previewMs+=performance.now()-start;
    if(!outcome.changes){decline(candidate,outcome.error??'资源、岗位或合法性限制',dependency);previewCache.set(key,null);return null;}
    const draft=applyStateChanges(parent.stage.draft,outcome.changes),stage=new StagingArea(draft,actor,false);stage.actions=outcome.actions!;
    const days=Math.min(1440,remaining),before=quickValueV4(parent.stage.draft,actor,coverage,days),after=quickValueV4(draft,actor,coverage,days);
    const child:BranchV4={stage,groups:[...parent.groups,candidate],risk:{...after.risk,value:Math.max(0,parent.risk.value+after.risk.value-before.risk.value)},value:parent.value+after.value-before.value+conditional([candidate]),verified:false};
    previewCache.set(key,child);return child;
  };
  let stop='无正收益',verifiedBranch:BranchV4=baseline;
  for(const [stageIndex,name] of ['crisis','military','economy'].entries()) {
    const stage=stages[name];
    const actionStart=root.stage.actions.length;
    while(stage.evaluations<stage.limit&&root.stage.actions.length<actionLimit(world)) {
      await checkpoint();
      const candidates=await candidatesFor(root,name);
      if(!candidates.length)break;
      let best:BranchV4|undefined;
      const count=Math.min(budget.width*2,stage.limit-stage.evaluations,candidates.length);
      let contenders=(await Promise.all(candidates.slice(0,count).map(candidate=>previewChild(root,candidate,name)))).filter((branch):branch is BranchV4=>!!branch).sort(compare);
      for(let depth=1;depth<budget.depth&&contenders.length&&stage.evaluations<stage.limit;depth++) {
        if(compare(contenders[0],root)<0)break;
        const expanded:BranchV4[]=[];
        for(const parent of contenders.slice(0,budget.width)) {
          // Reuse the complete lightweight list; each combination is still replayed and repriced on its own prefix.
          const next=candidates.filter(candidate=>!parent.groups.some(group=>group.id===candidate.id)&&!candidate.exclusive.some(key=>parent.groups.some(group=>group.exclusive.includes(key)))).slice(0,Math.min(2,stage.limit-stage.evaluations));
          for(const child of await Promise.all(next.map(candidate=>previewChild(parent,candidate,name))))if(child)expanded.push(child);
        }
        contenders=[...contenders,...expanded].sort(compare).slice(0,budget.width*2);report.search!.depth=Math.max(report.search!.depth,depth+1);
      }
      for(const child of contenders) {
        const candidate=child.groups.at(-1)!;
        const mandatory=child.groups.slice(root.groups.length).some(group=>['war','civilization','welfare','recovery','cancel'].includes(group.kind));
        const available=stage.forecasts<stage.forecastLimit&&report.forecasts<budget.forecasts-1;
        if(mandatory&&!available){decline(candidate,'本阶段详细风险预算不足',comparisonDependency(root,candidate));continue;}
        const delayed=child.groups.slice(root.groups.length).some(group=>['explore','colonize','base','expand','build'].includes(group.kind)&&group.value>0);
        if(available&&(mandatory||delayed||compare(child,root)<0)) {await project(child);stage.forecasts++;}
        if(candidate.military&&child.projection&&stage.forecasts<stage.forecastLimit&&report.forecasts<budget.forecasts-1) {
          const success=await project(child,true);if(success){stage.forecasts++;const benefit=Math.max(0,(success.horizons.at(-1)?.governance?.score??0)-(child.projection.horizons.at(-1)?.governance?.score??0));child.value+=benefit*CONFIG.preparationDiscount;}
        }
        if(!safe(child)){decline(candidate,'待遇、制度或留守风险未通过',comparisonDependency(root,candidate));continue;}
        if(compare(child,root)<0&&(!best||compare(child,best)<0))best=child;
        else if(compare(child,root)>=0)decline(candidate,`同前缀比较：风险 ${root.risk.value.toFixed(2)}→${child.risk.value.toFixed(2)}，价值 ${root.value.toFixed(2)}→${child.value.toFixed(2)}${child.verified?'（详细）':'（粗评）'}`,comparisonDependency(root,candidate));
      }
      if(!best) {
        for(const candidate of candidates.slice(0,count))decline(candidate,pending.get(candidate.id)?.reason??'组合比较后无可验证改善',comparisonDependency(root,candidate));
        if(stage.evaluations>=stage.limit)break;
        continue;
      }
      root=best;
      if(root.verified&&root.risk.value<=baseline.risk.value+CONFIG.riskTolerance)verifiedBranch=root;
      for(const group of root.groups){for(const key of group.exclusive)used.add(key);pending.delete(group.id);}
      stats.peakRssMb=Math.max(stats.peakRssMb,process.memoryUsage().rss/2**20);
    }
    if(name==='crisis')report.v4.crisisChecked=true;
    report.turn??={revision:CONFIG.revision,actions:0,planets:0,stop,stages:{},opportunities:[],value:{score:0,economy:0,functional:0,conditional:0,governanceCost:0},welfareSafe:true,threats:[]};
    report.turn.stages[name]={evaluations:stage.evaluations,forecasts:stage.forecasts,actions:root.stage.actions.length-actionStart};
    const nextName=['crisis','military','economy'][stageIndex+1];
    if(nextName){stages[nextName].limit+=stage.limit-stage.evaluations;stages[nextName].forecastLimit+=stage.forecastLimit-stage.forecasts;}
  }
  if(!root.verified)await project(root);
  if(!safe(root)||root.risk.value>baseline.risk.value+CONFIG.riskTolerance) {
    const verifiedIds=new Set(verifiedBranch.groups.map(group=>group.id));
    const retained=root.groups.filter(group=>verifiedIds.has(group.id)||['merge','scout','settle','demand','contact'].includes(group.kind));
    const stage=new StagingArea(world,actor);const accepted:MilitaryCandidateV4[]=[];
    for(const group of retained) {
      const trial=new StagingArea(stage.draft,actor);trial.actions=[...stage.actions];
      if(group.actions.every(action=>trial.execute(action.type,action.args).ok)){stage.draft=trial.draft;stage.actions=trial.actions;accepted.push(group);}
    }
    root={...verifiedBranch,stage,groups:accepted};stop='移除未验证的风险动作组，保留独立有效任务';
  }
  let checked=validateScriptPlan(world,actor,root.stage.actions);report.validations=1;report.search!.evaluations++;
  while(!checked.ok&&report.validations<3) {
    report.rejected.push({attempt:report.validations,index:checked.index,reason:checked.reason});
    const failed=root.stage.actions[checked.index],group=root.groups.find(group=>group.actions.some(action=>JSON.stringify(action)===JSON.stringify(failed)));
    const retained=root.groups.filter(candidate=>candidate!==group&&!candidate.exclusive.some(key=>group?.exclusive.includes(key)));
    const stage=new StagingArea(world,actor),accepted:MilitaryCandidateV4[]=[];
    for(const candidate of retained) {
      const trial=new StagingArea(stage.draft,actor);trial.actions=[...stage.actions];
      if(candidate.actions.every(action=>trial.execute(action.type,action.args).ok)){stage.draft=trial.draft;stage.actions=trial.actions;accepted.push(candidate);}
    }
    root={...root,stage,groups:accepted};checked=validateScriptPlan(world,actor,stage.actions);report.validations++;report.search!.evaluations++;
  }
  if(!checked.ok)throw new Error('adaptive-v4 三次原边界整批校验失败：'+checked.reason);
  for(const group of root.groups) {
    report.selected.push({id:group.id,label:group.label,actions:group.actions,fingerprint:v3FailureDependency(world,actor,group.actions,'共同结算归属失败')});
    memory.tasks=memory.tasks.filter(task=>!group.tasks.some(next=>next.fleetId===task.fleetId));memory.tasks.push(...group.tasks);
    if(group.military&&group.military.mode!=='defend') {
      const option=group.military,prior=memory.operation,same=prior?.id===option.id;
      memory.operation={id:option.id,opponent:option.opponent,targets:[option.target],warType:option.warType,stage:group.kind==='war'?'attack':group.kind==='prepare'?'prepare':group.kind==='scout'?'recon':'assemble',fleetIds:option.fleetIds.filter(id=>checked.stage.draft.fleets.some(fleet=>fleet.id===id)),staging:option.staging,createdDay:same?prior.createdDay:world.day,deadline:same?prior.deadline:option.expectedDay+600,progress:same?prior.progress:'',lastProgressRound:same?prior.lastProgressRound:world.round,value:option.value,reserve:{},blockers:option.blockers,nextStep:group.kind==='war'?'按实际控制推进并兑现目标':group.kind==='assemble'?'指定舰队到齐后复核并发起进攻':'等待必要条件完成后复核',launchDay:option.ready?world.day:null,ready:option.ready};
      memory.goal={id:option.id,kind:group.kind,target:option.target,stage:memory.operation.stage,value:option.value,prerequisites:option.blockers,deadline:memory.operation.deadline,progress:memory.operation.progress,lastProgressRound:memory.operation.lastProgressRound};
    }
  }
  if(root.stage.actions.length>=actionLimit(world))stop='达到48条实际动作上限';
  else if(report.search!.evaluations>=budget.evaluations-3)stop='草稿评估预算耗尽';
  else if(report.forecasts>=budget.forecasts-1)stop='详细风险预算耗尽，独立安全任务已比较';
  else if(!root.stage.actions.length&&report.v4.risk.value>0)stop='危机方案已检查，现有资源、岗位或时限无法产生已验证改善';
  else if(stop==='无正收益')stop=explainConstraintsV4([...pending.values()].filter(item=>item.dependency===comparisonDependency(root,item.candidate)).map(item=>item.reason),checked.stage.draft.factions[actor].resources);
  const last=root.projection?.horizons.at(-1);
  report.turn={...report.turn!,actions:checked.stage.actions.length,planets:new Set(checked.stage.actions.map(action=>action.args.planetId).filter(Boolean)).size,stop,opportunities:[...pending.values()].sort((first,second)=>second.candidate.value-first.candidate.value||first.candidate.id.localeCompare(second.candidate.id)).slice(0,3).map(item=>({id:item.candidate.id,label:item.candidate.label,reason:item.reason,value:item.candidate.value})),value:{score:last?.governance?.score??0,economy:last?.governance?.value?.economy??0,functional:last?.governance?.value?.functional??0,conditional:conditional(root.groups),governanceCost:root.risk.lowUnityDays*CONFIG.lowUnityDayValue},welfareSafe:safe(root),threats:report.v4.military.filter(option=>option.mode==='defend')};
  report.v4.finalRisk=root.risk;report.v4.pending=[...pending.values()].slice(0,32).map(item=>({id:item.candidate.id,reason:item.reason,dependency:item.dependency}));
  report.exhausted=stop.includes('预算');report.performance=stats;report.selectedProjection=digest(checked.stage.actions)+':no-success';
  report.alternatives=report.v4.military.filter(option=>!root.groups.some(group=>group.id===option.id)).slice(0,3).map(option=>({id:option.id,label:option.opponent+'/'+option.target+'/'+option.warType,priority:0,value:option.value,risk:Math.max(0,-Math.min(...option.scenarios.map(scenario=>scenario.value))),reason:option.blockers.join('；')||'相对收益不足或本轮资源另有用途',evidenceDays:option.intelDays,selected:false}));
  return {actions:checked.stage.actions,trace:checked.stage.trace,scriptMemory:memory,scriptReport:report,summary:'adaptive-v4 '+profile+'：'+checked.stage.actions.length+'条动作；'+root.groups.slice(0,5).map(group=>group.label).join('；')+'；'+stop+'；模型请求0。',metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v4'}};
}
