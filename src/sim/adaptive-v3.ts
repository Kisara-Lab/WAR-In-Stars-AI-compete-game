import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ADAPTIVE, ADAPTIVE_V3, type ScriptMemory, type ScriptReport } from '../shared/adaptive.js';
import { policyComparison } from '../shared/comparison.js';
import { actionLimit, governanceView } from '../shared/governance.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import { candidateFacts } from './adaptive-candidates.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { validateScriptPlan } from './adaptive-adapter.js';
import { StagingArea } from './actions.js';
import { economicForecast } from './forecast.js';
import { forecastInput } from './adaptive-v2.js';
import type { ForecastScenario } from './forecast-v3.js';
import { dutyPaths } from './social.js';
import { emptyMetrics } from './bot.js';
import { extractionDuty } from './emergency.js';
import { previewDraft } from './preview.js';
import { RESPONSIBILITY } from '../shared/responsibility.js';
import { campaignCandidates, defenseCandidates, defenseOutlook } from './adaptive-v3-campaign.js';
import { planningPreview } from './planning-preview.js';
import { applyStateChanges } from './planning-delta.js';
import { v3FailureDependency } from './adaptive-v3-failures.js';
import { v3Coverage, v3StaticTimeline } from './adaptive-v3-values.js';
import { V53 } from '../shared/governance.js';
export { v3FailureDependency } from './adaptive-v3-failures.js';

export interface V3Hooks {
  forecast?:(state:GameState,actor:string,horizons:number[],scenario:ForecastScenario)=>Promise<ReturnType<typeof economicForecast>>;
  checkpoint?:()=>Promise<void>;
  inputAudit?:(input:unknown)=>Promise<void>;
  preview?:(state:GameState,actor:string,actions:Action[],candidate:ScriptCandidate)=>Promise<ReturnType<typeof planningPreview>>;
  candidates?:(state:GameState,actor:string,limit:number)=>Promise<ReturnType<typeof candidateFacts>>;
}
interface Branch {
  stage:StagingArea; selected:ScriptCandidate[]; used:Set<string>; key:string;
  risk:number; defense:number; economic:number; functional:number; conditional:number;
  score:number; governanceCost:number;
  projection?:ReturnType<typeof economicForecast>;
  staticValue?:ReturnType<typeof v3StaticTimeline>[];
  success?:ReturnType<typeof economicForecast>;
}
const strategic = new Set(['war','prepare','claim','scout','assemble']);
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (first:Branch,second:Branch) => first.risk-second.risk ||
  first.defense-second.defense ||
  (second.score+second.economic+second.functional+second.conditional-second.governanceCost)-(first.score+first.economic+first.functional+first.conditional-first.governanceCost) ||
  first.stage.actions.length-second.stage.actions.length || first.key.localeCompare(second.key,'en');

export async function adaptiveV3Decision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:V3Hooks={}):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('adaptive-v3 仅支持5.4');
  const started=performance.now(),cpuStart=process.threadCpuUsage();
  const profile=world.config.scriptSearchProfile??'standard',budget=ADAPTIVE_V3.profiles[profile];
  const memory:ScriptMemory=previous?.version==='adaptive-v3'?structuredClone(previous):{version:'adaptive-v3',goal:null,tasks:[],failures:[]};
  const report:ScriptReport={version:'adaptive-v3',candidates:0,forecasts:0,validations:0,exhausted:false,alternatives:[],selected:[],rejected:[],projections:[],assumptions:'同一前缀完整比较；无新成果为确定预测，战争成功仅为条件情景；未知敌军不是零。',search:{profile,evaluations:1,depth:0,combinations:[]}};
  const timings={candidateMs:0,copyMs:0,staticMs:0,forecastTaskMs:0,forecastWallMs:0,previewWallMs:0,validationMs:0,cacheHits:0,usefulForecasts:0,discardedForecasts:0,coordinatorThreadCpuSpanMs:0,peakHeapMb:0};
  const checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  const remaining=Math.max(0,(world.config.maxRounds-world.round)*100);
  const horizons=[...new Set([300,720,1440].map(days=>Math.min(days,remaining)))].filter(Boolean);
  const coverage=v3Coverage(world,actor),endDay=world.day+remaining;
  const combinationEvaluations=Math.floor((budget.evaluations-3)*(1-ADAPTIVE_V3.residualShare));
  const combinationForecasts=1+Math.floor((budget.forecasts-2)*ADAPTIVE_V3.combinationForecastShare);
  const opportunities=new Map<string,{id:string;label:string;reason:string;value:number}>();
  const stages:NonNullable<ScriptReport['turn']>['stages']={};
  const decline=(candidate:ScriptCandidate,reason:string)=>opportunities.set(candidate.id,{id:candidate.id,label:candidate.label,reason,value:candidate.value});
  const admitted=new Set<string>();
  const preview=hooks.preview??(async(state,actor,actions,candidate)=>planningPreview(state,actor,actions,candidate));
  const generate=hooks.candidates??(async(state,actor,limit)=>candidateFacts(state,actor,true,limit,true));
  const generatedCache=new WeakMap<Branch,ReturnType<typeof candidateFacts>>();
  const previewCache=new WeakMap<Branch,Map<string,Promise<Branch|null>>>();
  let campaignInitialized=false;
  const candidatesFor=(branch:Branch,generated:ReturnType<typeof candidateFacts>)=>{
    report.comparisons??=generated.comparisons;
    if(!campaignInitialized){campaignCandidates(branch.stage.draft,actor,memory,generated.candidates);campaignInitialized=true;}
    const branchMemory=structuredClone(memory);
    const opponentFor=(candidate:ScriptCandidate)=>String(candidate.actions.find(action=>action.args.factionId)?.args.factionId??branch.stage.draft.systems.find(system=>system.id===candidate.target)?.ownerId??candidate.target);
    const plannedOffense=branch.selected.find(candidate=>['war','prepare','claim'].includes(candidate.kind));
    const candidates=[...campaignCandidates(branch.stage.draft,actor,branchMemory,generated.candidates),...defenseCandidates(branch.stage.draft,actor)].filter(candidate=>{
      if(branch.selected.some(selected=>selected.id===candidate.id)||candidate.exclusive.some(key=>branch.used.has(key)))return false;
      if(plannedOffense&&['war','prepare','claim'].includes(candidate.kind)&&opponentFor(candidate)!==opponentFor(plannedOffense))return false;
      if(memory.failures.some(failure=>failure.key===candidate.id&&failure.fingerprint===v3FailureDependency(world,actor,candidate.actions,failure.reason))){decline(candidate,'相关失败条件和情报尚未变化');return false;}
      if(candidate.actions.length===0){for(const task of candidate.tasks)if(!memory.tasks.some(previous=>previous.fleetId===task.fleetId))memory.tasks.push(task);return false;}
      return true;
    }).sort((first,second)=>second.priority-first.priority||second.value-first.value||first.id.localeCompare(second.id,'en'));
    return candidates.filter(candidate=>admitted.has(candidate.id)||admitted.size<budget.candidates);
  };
  const scenarioFor=(state:GameState):ForecastScenario=>{
    const concerns=state.social?.concerns.filter(concern=>concern.target!==actor&&concern.closedDay===undefined&&concern.known[actor]!==undefined)??[];
    const deadlines=concerns.map(concern=>Math.max(concern.known[actor],state.factions[actor].civilization?.establishedDay??0)+RESPONSIBILITY.responseDays);
    if(state.factions[actor].civilization?.choice==='utopia')for(const foreign of Object.values(state.factions)) {
      const extraction=foreign.extraction;if(!extraction||extraction.known[actor]===undefined||extraction.fulfilledDay!==undefined)continue;
      const demand=extraction.demands.find(demand=>demand.actor===actor);
      const deadline=demand?Math.min(demand.rejectedDay??demand.deadline,demand.deadline):Math.max(extraction.known[actor],state.factions[actor].civilization!.establishedDay)+180;
      const draft=previewDraft(state);draft.day=Math.max(state.day,deadline)+10;
      if(extractionDuty(draft,actor).details.some(detail=>detail.eventId===extraction.id&&detail.ignored))deadlines.push(Math.max(state.day,deadline));
    }
    return {actionable:dutyPaths(state,actor).actionable,coverage,endDay,...(deadlines.length?{rescueDueDay:Math.min(...deadlines)}:{})};
  };
  const forecast=hooks.forecast??(async(state,actor,days,scenario)=>economicForecast(state,actor,days,scenario));
  const project=async(branch:Branch,success=false)=>{
    if(report.forecasts>=budget.forecasts)return;
    report.forecasts++;
    const time=performance.now(),scenario=scenarioFor(branch.stage.draft);
    if(success)scenario.successDay=branch.selected.find(candidate=>candidate.successDay!==undefined)?.successDay??world.day;
    const result=await forecast(forecastInput(branch.stage.draft,actor),actor,horizons,scenario);
    timings.forecastTaskMs+=performance.now()-time;
    report.projections!.push({id:branch.key+(success?':conditional-success':':no-new-success'),horizons:result.horizons,trajectory:result.trajectory});
    if(success){branch.success=result;const gain=Math.max(0,(result.horizons.at(-1)?.governance?.score??0)-(branch.projection?.horizons.at(-1)?.governance?.score??0));branch.conditional+=gain*ADAPTIVE_V3.conditionalWeight;return;}
    branch.projection=result;timings.usefulForecasts++;
    const last=result.horizons.at(-1);
    branch.risk=segmentedRisk(result.horizons);
    branch.score=last?.governance?.score??branch.score;
    branch.economic=result.horizons.reduce((sum,row)=>sum+(row.governance?.value?.economy??0),0)/Math.max(1,result.horizons.length)-branch.selected.filter(candidate=>candidate.kind==='civilization').length*100;
    branch.functional=result.horizons.reduce((sum,row)=>sum+(row.governance?.value?.functional??0),0)/Math.max(1,result.horizons.length);
    branch.governanceCost=(last?.governance?.lowUnityDays??0)*ADAPTIVE_V3.unityDayCost+Math.max(0,Math.min(60,world.factions[actor].unity/100)-(last?.governance?.futureMinimumUnity??100))*ADAPTIVE_V3.unityDeclineCost;
  };
  const segmentedRisk=(rows:{shortageDays:number;unpaidDays:number}[])=>{
    let previousShort=0,previousUnpaid=0,total=0;
    for(const [index,row] of rows.entries()) {total+=(Math.max(0,row.shortageDays-previousShort)*ADAPTIVE.shortagePenalty+Math.max(0,row.unpaidDays-previousUnpaid)*ADAPTIVE.unpaidPenalty)*.5**index;previousShort=row.shortageDays;previousUnpaid=row.unpaidDays;}
    return Math.round(total);
  };
  const cheap=(branch:Branch)=>{
    const staticStarted=performance.now();
    const state=branch.stage.draft;
    const rows=branch.staticValue??horizons.map(days=>v3StaticTimeline(forecastInput(state,actor),actor,days,coverage));branch.staticValue=rows;
    const last=rows.at(-1);
    branch.risk=segmentedRisk(rows);
    branch.defense=defenseOutlook(state,actor).reduce((sum,threat)=>sum+threat.deficit,0);
    branch.score=last?.score??0;
    branch.economic=rows.reduce((sum,row)=>sum+row.economy,0)/Math.max(1,rows.length)-branch.selected.filter(candidate=>candidate.kind==='civilization').length*100;
    branch.functional=rows.reduce((sum,row)=>sum+row.functional,0)/Math.max(1,rows.length);
    branch.governanceCost=(last?.lowUnityDays??0)*ADAPTIVE_V3.unityDayCost+Math.max(0,Math.min(60,world.factions[actor].unity/100)-(last?.minimumUnity??100))*ADAPTIVE_V3.unityDeclineCost;
    branch.conditional=branch.selected.reduce((sum,candidate)=>sum+(['jobs','status','build','welfare','policy','civilization','ships','cancel','defend','colonize'].includes(candidate.kind)?0:candidate.value*(['war','prepare','claim'].includes(candidate.kind)?ADAPTIVE_V3.conditionalWeight:1)),0);
    timings.staticMs+=performance.now()-staticStarted;
  };
  let root:Branch={stage:new StagingArea(world,actor),selected:[],used:new Set(),key:'wait',risk:0,defense:0,economic:0,functional:0,conditional:0,score:0,governanceCost:0};
  cheap(root);const baselineStarted=performance.now();await project(root);timings.forecastWallMs+=performance.now()-baselineStarted;
  const baseline=root;
  const welfareRaised=(branch:Branch)=>V53.treatment[branch.stage.draft.factions[actor].welfare!.choice]>V53.treatment[world.factions[actor].welfare!.choice];
  const safeCommitment=(branch:Branch)=>{
    if(welfareRaised(branch)) {
      if(!branch.projection||branch.projection.horizons.some((row,index)=>row.shortageDays>baseline.projection!.horizons[index].shortageDays||row.unpaidDays>baseline.projection!.horizons[index].unpaidDays))return false;
      if(branch.defense>baseline.defense)return false;
      if(memory.campaign?.committed&&Object.entries(memory.campaign.reserve).some(([resource,value])=>(branch.stage.draft.factions[actor].resources[resource as 'minerals']??0)<value*1000))return false;
    }
    if(branch.selected.some(candidate=>candidate.kind==='civilization')) {
      const choice=branch.stage.draft.factions[actor].civilization?.choice;
      if(['militarist','theocracy'].includes(choice??'')&&!branch.selected.some(candidate=>candidate.kind==='war'||candidate.kind==='settle')&&dutyPaths(branch.stage.draft,actor).actionable)return false;
    }
    return true;
  };
  const detail=async(branch:Branch,limit:number)=>{
    if(!branch.projection&&report.forecasts<limit)await project(branch);
    if(!branch.success&&branch.selected.some(candidate=>candidate.kind==='war'||candidate.kind==='settle')&&report.forecasts<limit)await project(branch,true);
  };
  const initialGeneration=performance.now(),initial=await generate(world,actor,budget.candidates);
  timings.candidateMs+=performance.now()-initialGeneration;generatedCache.set(root,initial);report.comparisons=initial.comparisons;
  const extraction=world.factions[actor].extraction,exit=initial.facts.comparison.emergencyEconomy?.withoutSubsidy;
  if(extraction&&extraction.expiresDay>world.day&&exit)memory.recovery={deadline:extraction.expiresDay,lastCheckedDay:world.day,shortages:{...exit.shortages},welfareFraction:exit.welfareFraction??1,normalNet:exit.resourcesPer100};
  else delete memory.recovery;
  await hooks.inputAudit?.({profile,budget,observedDay:world.day,facts:initial.facts,comparison:report.comparisons});
  while(report.search!.evaluations<combinationEvaluations&&report.forecasts<combinationForecasts&&root.stage.actions.length<actionLimit(world)) {
    let beam=[root];
    for(let depth=0;depth<budget.depth;depth++) {
      await checkpoint();
      const expanded:Branch[]=[...beam];
      const generationStart=performance.now();
      const generatedBatch=await Promise.all(beam.map(async branch=>{
        const cached=generatedCache.get(branch);if(cached){timings.cacheHits++;return cached;}
        const generated=await generate(branch.stage.draft,actor,budget.candidates);generatedCache.set(branch,generated);return generated;
      }));
      timings.candidateMs+=performance.now()-generationStart;
      for(const [parentIndex,parent] of beam.entries()) {
        const choices=candidatesFor(parent,generatedBatch[parentIndex]);
        const perBranch=Math.min(choices.length,Math.max(budget.width*2,Math.floor((combinationEvaluations-report.search!.evaluations)/Math.max(1,(budget.depth-depth)*beam.length*2))));
        const representatives=[...new Set(choices.map(candidate=>candidate.kind))].map(kind=>choices.find(candidate=>candidate.kind===kind)!);
        const scheduled=[...representatives,...choices.filter(candidate=>!representatives.includes(candidate))].slice(0,perBranch);
        const pending:Promise<Branch|null>[]=[];
        const previewStarted=performance.now();
        const parentCache=previewCache.get(parent)??new Map<string,Promise<Branch|null>>();previewCache.set(parent,parentCache);
        for(const candidate of scheduled) {
          const cached=parentCache.get(candidate.id);if(cached){timings.cacheHits++;pending.push(cached);continue;}
          if(report.search!.evaluations>=combinationEvaluations)break;
          if(!admitted.has(candidate.id)&&admitted.size>=Math.floor(budget.candidates*(1-ADAPTIVE_V3.residualShare)))continue;
          admitted.add(candidate.id);report.candidates=admitted.size;
          report.search!.evaluations++;
          const job=(async()=>{
          const outcome=await preview(parent.stage.draft,actor,parent.stage.actions,candidate);
          if(!outcome.changes){decline(candidate,outcome.error??'资源、岗位或情报条件不满足');return null;}
          const copyStart=performance.now(),stage=new StagingArea(applyStateChanges(parent.stage.draft,outcome.changes),actor,false);stage.actions=outcome.actions!;
          timings.copyMs+=performance.now()-copyStart;
          const child:Branch={stage,selected:[...parent.selected,candidate],used:new Set([...parent.used,...candidate.exclusive]),key:digest(stage.actions),risk:0,defense:0,economic:0,functional:0,conditional:0,score:0,governanceCost:0};
          cheap(child);return child;
          })();parentCache.set(candidate.id,job);pending.push(job);
        }
        for(const child of await Promise.all(pending))if(child)expanded.push(child);
        timings.previewWallMs+=performance.now()-previewStarted;
      }
      const byKey=new Map<string,Branch>();
      for(const branch of expanded){const prior=byKey.get(branch.key);if(!prior||!prior.projection&&branch.projection)byKey.set(branch.key,branch);}
      const unique=[...byKey.values()].sort(compare);
      const contenders=unique.filter(branch=>!branch.projection).slice(0,Math.min(budget.width*2,combinationForecasts-report.forecasts));
      const forecastingStarted=performance.now();await Promise.all(contenders.map(branch=>project(branch)));timings.forecastWallMs+=performance.now()-forecastingStarted;
      for(const branch of contenders)if(report.forecasts<combinationForecasts)await detail(branch,combinationForecasts);
      beam=unique.filter(branch=>branch.projection&&safeCommitment(branch)).sort(compare).slice(0,budget.width);
      if(!beam.length)beam=[root];
      report.search!.depth=Math.max(report.search!.depth,depth+1);
      if(report.forecasts>=combinationForecasts||report.search!.evaluations>=combinationEvaluations)break;
    }
    const best=beam.sort(compare)[0];
    report.search!.combinations.push(...beam.slice(0,3).map(branch=>({ids:branch.selected.map(candidate=>candidate.id),risk:branch.risk,criticalThreats:branch.defense,economic:branch.economic,functional:branch.functional,conditional:branch.conditional})));
    if(best.key===root.key||compare(best,root)>=0)break;
    root=best;
    timings.peakHeapMb=Math.max(timings.peakHeapMb,process.memoryUsage().heapUsed/2**20);
  }
  stages.combination={evaluations:report.search!.evaluations,forecasts:report.forecasts,actions:root.stage.actions.length};
  let safePrefix=root,stop='无正收益';
  const evaluatedBefore=report.search!.evaluations,forecastBefore=report.forecasts,actionsBefore=root.stage.actions.length;
  while(root.stage.actions.length<actionLimit(world)&&report.search!.evaluations<budget.evaluations-3) {
    await checkpoint();
    const generationStarted=performance.now();
    let generated=generatedCache.get(root);
    if(!generated){generated=await generate(root.stage.draft,actor,budget.candidates);generatedCache.set(root,generated);}
    timings.candidateMs+=performance.now()-generationStarted;
    const choices=candidatesFor(root,generated);
    if(!choices.length){stop='没有可执行候选：检查资源、岗位及情报';break;}
    const staticParent={...root,projection:undefined,success:undefined};cheap(staticParent);
    let selected:Branch|undefined;
    const batchWidth=Math.max(1,Math.min(ADAPTIVE_V3.residualBatch,Math.floor((budget.evaluations-3-report.search!.evaluations)/Math.max(1,actionLimit(world)-root.stage.actions.length))));
    for(let offset=0;offset<choices.length&&!selected&&report.search!.evaluations<budget.evaluations-3;offset+=batchWidth) {
      const batch=choices.slice(offset,offset+Math.min(batchWidth,budget.evaluations-3-report.search!.evaluations));
      const children=await Promise.all(batch.map(async candidate=>{
        if(!admitted.has(candidate.id)&&admitted.size>=budget.candidates){decline(candidate,'候选预算耗尽');return null;}
        admitted.add(candidate.id);report.candidates=admitted.size;report.search!.evaluations++;
        const previewStarted=performance.now(),outcome=await preview(root.stage.draft,actor,root.stage.actions,candidate);timings.previewWallMs+=performance.now()-previewStarted;
        if(!outcome.changes){decline(candidate,outcome.error??'资源、岗位或情报条件不满足');return null;}
        const stage=new StagingArea(applyStateChanges(root.stage.draft,outcome.changes),actor,false);stage.actions=outcome.actions!;
        const child:Branch={stage,selected:[...root.selected,candidate],used:new Set([...root.used,...candidate.exclusive]),key:digest(stage.actions),risk:0,defense:0,economic:0,functional:0,conditional:0,score:0,governanceCost:0};
        cheap(child);
        for(const key of ['risk','score','economic','functional','governanceCost'] as const)child[key]+=root[key]-staticParent[key];
        child.risk=Math.max(0,child.risk);
        return child;
      }));
      const ranked=children.filter((child):child is Branch=>!!child).sort(compare);
      for(const child of ranked) {
        const candidate=child.selected.at(-1)!;
        const required=['civilization','war','welfare'].includes(candidate.kind)||child.risk!==root.risk||['recovery','cancel'].includes(candidate.kind);
        if(required&&report.forecasts>=budget.forecasts-1){decline(candidate,'详细风险预算不足，不能放宽高风险选择');continue;}
        const uncertain=['jobs','status','build','policy'].includes(candidate.kind)&&report.forecasts<budget.forecasts-1;
        if(required||uncertain)await detail(child,budget.forecasts-1);
        if(!safeCommitment(child)){decline(candidate,'福利全窗口、留守或履责路径未通过');continue;}
        if(compare(child,root)<0){selected=child;break;}
        decline(candidate,'同前缀下收益或风险不优于等待');
      }
    }
    if(!selected)break;
    root=selected;if(root.projection)safePrefix=root;
    for(const candidate of root.selected)opportunities.delete(candidate.id);
  }
  if(root.stage.actions.length>=actionLimit(world))stop='达到48条实际动作上限';
  else if(report.search!.evaluations>=budget.evaluations-3)stop='草稿评估预算耗尽';
  else if(admitted.size>=budget.candidates)stop='候选预算耗尽';
  if(!root.projection)await project(root);
  if(!safeCommitment(root)||root.risk>Math.max(baseline.risk,safePrefix.risk)) {
    for(const candidate of root.selected.filter(candidate=>!safePrefix.selected.includes(candidate)))decline(candidate,'最终整轮预测发现额外风险，撤回未验证后缀');
    root=safePrefix;stop='最终预测撤回风险增加的后缀';
  }
  stages.residual={evaluations:report.search!.evaluations-evaluatedBefore,forecasts:report.forecasts-forecastBefore,actions:root.stage.actions.length-actionsBefore};
  report.turn={revision:ADAPTIVE_V3.repair,actions:root.stage.actions.length,planets:new Set(root.stage.actions.map(action=>action.args.planetId).filter(Boolean)).size,stop,stages,opportunities:[...opportunities.values()].sort((first,second)=>second.value-first.value||first.id.localeCompare(second.id)).slice(0,3),value:{score:root.score,economy:root.economic,functional:root.functional,conditional:root.conditional,governanceCost:root.governanceCost},welfareSafe:safeCommitment(root),threats:defenseOutlook(root.stage.draft,actor)};
  report.exhausted=report.forecasts>=budget.forecasts-1||report.search!.evaluations>=budget.evaluations-3;
  report.selectedProjection=root.key+':no-new-success';
  report.alternatives=report.search!.combinations.filter(combination=>combination.ids.join()!==root.selected.map(candidate=>candidate.id).join()).slice(-3).map((combination,index)=>({id:'combination-'+index,label:combination.ids.join(' + ')||'等待',priority:0,value:combination.economic+combination.functional+combination.conditional,risk:combination.risk,reason:'完整比较风险、实际得分、功能与条件收益后未选',evidenceDays:[world.day],selected:false}));
  campaignCandidates(root.stage.draft,actor,memory,root.selected);
  for(const candidate of root.selected) {
    report.selected.push({id:candidate.id,label:candidate.label,actions:candidate.actions,fingerprint:v3FailureDependency(world,actor,candidate.actions,'共同结算归属失败')});
    for(const task of candidate.tasks){memory.tasks=memory.tasks.filter(previous=>previous.fleetId!==task.fleetId);memory.tasks.push(task);}
    if(strategic.has(candidate.kind)&&candidate.kind!=='scout') {
      const system=world.systems.find(system=>system.id===candidate.target),opponent=String(candidate.actions.find(action=>action.args.factionId)?.args.factionId??system?.ownerId??candidate.target);
      const progress=memory.campaign?.progress??digest({owner:system?.ownerId,intel:world.factions[actor].militaryIntel?.[candidate.target]?.day,preparation:world.conquests?.filter(item=>item.actor===actor)});
      const last=memory.campaign;
      memory.campaign={...last,opponent,target:system?.id??last?.target??candidate.target,stage:candidate.kind,reserve:last?.reserve??{},progress,lastProgressRound:last?.progress===progress?last.lastProgressRound:world.round,blockers:last?.blockers??[],committed:true};
      memory.goal={id:candidate.id,kind:candidate.kind,target:candidate.target,stage:candidate.kind,value:candidate.value,prerequisites:[candidate.reason],deadline:candidate.deadline,progress,lastProgressRound:memory.campaign.lastProgressRound};
    }
  }
  if(memory.campaign&&world.round-memory.campaign.lastProgressRound>=ADAPTIVE.stalledRounds){memory.campaign.stage='investigate';memory.campaign.blockers=['连续两轮无实际进展：重新检查军情、通行和补给'];}
  const validation=performance.now();
  let actions=root.stage.actions,checked=validateScriptPlan(world,actor,actions);report.validations=1;report.search!.evaluations++;
  while(!checked.ok&&report.validations<ADAPTIVE.attempts) {
    report.rejected.push({attempt:report.validations,index:checked.index,reason:checked.reason});
    const failed=actions[checked.index];
    const group=root.selected.find(candidate=>candidate.actions.some(action=>JSON.stringify(action)===JSON.stringify(failed)));
    const start=group?actions.findIndex(action=>JSON.stringify(action)===JSON.stringify(group.actions[0])):checked.index;
    if(start<=0)throw new Error('adaptive-v3 修正将掩盖完整计划错误，整轮暂停：'+checked.reason);
    actions=actions.slice(0,start);
    checked=validateScriptPlan(world,actor,actions);report.validations++;report.search!.evaluations++;
  }
  timings.validationMs=performance.now()-validation;
  if(!checked.ok)throw new Error('adaptive-v3 原边界完整校验失败：'+checked.reason);
  if(actions.length!==root.stage.actions.length) {
    report.selected=report.selected.filter(candidate=>candidate.actions.every(action=>actions.some(accepted=>JSON.stringify(accepted)===JSON.stringify(action))));
    memory.goal=null;delete memory.campaign;memory.tasks=[];
  }
  const cpu=process.threadCpuUsage(cpuStart);timings.coordinatorThreadCpuSpanMs=(cpu.user+cpu.system)/1000;report.performance=timings;
  report.projections?.sort((first,second)=>first.id.localeCompare(second.id,'en'));
  report.turn.actions=checked.stage.actions.length;
  return {actions:checked.stage.actions,trace:checked.stage.trace,scriptMemory:memory,scriptReport:report,summary:'adaptive-v3 '+profile+'：'+checked.stage.actions.length+'条动作；'+(root.selected.slice(0,5).map(candidate=>candidate.label).join('；')||'等待')+'；'+report.turn.stop+'；模型请求0。',metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v3'}};
}
