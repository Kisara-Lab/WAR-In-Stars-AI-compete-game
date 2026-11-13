import { ADAPTIVE, type ScriptMemory } from '../shared/adaptive.js';
import type { Action } from '../shared/types.js';
import type { Immutable, ScriptCandidate, ScriptObservation, ScriptPlan, ScriptPlanning } from './adaptive-types.js';

export async function planAdaptive(input: Immutable<ScriptObservation>, previous: Immutable<ScriptMemory> | undefined, api: ScriptPlanning): Promise<ScriptPlan> {
  const memory: ScriptMemory = previous ? structuredClone(previous) as ScriptMemory : {version:'adaptive-v1',goal:null,tasks:[],failures:[]};
  const report: ScriptPlan['report'] = {version:'adaptive-v1',candidates:input.candidates.length,forecasts:0,validations:0,exhausted:input.truncated,alternatives:[],selected:[],rejected:[],assumptions:'本方已知经济，冻结控制权；战争收益为条件估计，未知敌军不按零。预测不保证未来供应或胜利。'};
  const actions: Action[] = [];
  const used = new Set<string>();
  const baseline = api.preview([],null,true);
  report.forecasts++;
  report.projections=baseline.projection?[{id:'wait',horizons:baseline.projection.horizons}]:[];
  let risk = baseline.risk;
  if(memory.goal&&input.goalStatus) {
    if(!input.goalStatus.valid||input.goalStatus.completed)memory.goal=null;
    else if(memory.goal.progress!==input.goalStatus.progress){memory.goal.progress=input.goalStatus.progress;memory.goal.lastProgressRound=input.round;}
  }
  const prior = memory.goal;
  const stalled = !!prior && input.round-prior.lastProgressRound>=ADAPTIVE.stalledRounds;
  const candidates = [...input.candidates].sort((first,second)=>second.priority-first.priority ||
    (second.value*(second.id===prior?.id&&!stalled?ADAPTIVE.switchRatio:1)-first.value*(first.id===prior?.id&&!stalled?ADAPTIVE.switchRatio:1)) || first.id.localeCompare(second.id,'en'));
  const selected: Immutable<ScriptCandidate>[]=[];
  for(const candidate of candidates) {
    await api.yield();
    let reason = '';
    if(candidate.exclusive.some(key=>used.has(key))) reason='本轮已分配相同资源用途或舰队任务';
    else if(memory.failures.some(failure=>failure.key===candidate.id&&failure.fingerprint===candidate.fingerprint)) reason='相同失败事实尚未改变，等待对应前提或情报更新';
    else if(candidate.value<=0&&candidate.priority<2) reason='不优于暂不行动';
    else {
      const detailed=candidate.economic&&report.forecasts<ADAPTIVE.forecasts;
      const preview=api.preview(actions,candidate,detailed);
      if(preview.projection){report.forecasts++;report.projections.push({id:candidate.id,horizons:preview.projection.horizons});}
      if(!preview.ok) reason=preview.reason;
      else if(preview.actionCount>input.actionLimit) reason='展开动作超出本轮额度';
      else if(preview.risk>risk&&candidate.priority<3) reason='300日供应风险增加，保留安全储备';
      else if(preview.value<=0&&preview.risk>=risk&&candidate.priority<2) reason='计入已付款产能和岗位后净收益不足';
      else {
        actions.push(...structuredClone(candidate.actions) as Action[]);
        candidate.exclusive.forEach(key=>used.add(key));
        selected.push(candidate);risk=preview.risk;
        report.selected.push({id:candidate.id,label:candidate.label,actions:structuredClone(candidate.actions) as Action[],fingerprint:candidate.fingerprint});
      }
    }
    if(reason) report.alternatives.push({id:candidate.id,label:candidate.label,priority:candidate.priority,value:candidate.value,risk:candidate.risk,reason,evidenceDays:[...candidate.evidenceDays],selected:false});
  }
  report.exhausted ||= report.forecasts===ADAPTIVE.forecasts;
  report.alternatives=report.alternatives.slice(0,3);
  const proposed=selected.find(candidate=>['war','claim','prepare','scout','colonize','base','civilization','recovery'].includes(candidate.kind)) ?? (prior?undefined:selected[0]);
  const goal=proposed&&(!prior||stalled||proposed.priority>=2||proposed.id===prior.id||proposed.value>prior.value*ADAPTIVE.switchRatio)?proposed:undefined;
  memory.goal=goal ? {id:goal.id,kind:goal.kind,target:goal.target,stage:goal.kind,value:goal.value,prerequisites:[goal.reason],deadline:goal.deadline,progress:goal.progress,lastProgressRound:prior?.id===goal.id&&prior.progress===goal.progress?prior.lastProgressRound:input.round} : prior&&prior.deadline>input.day&&!stalled?structuredClone(prior):null;
  const tasks=new Map(memory.tasks.map(task=>[task.fleetId,task]));
  for(const task of selected.flatMap(candidate=>structuredClone(candidate.tasks) as ScriptMemory['tasks']))tasks.set(task.fleetId,task);
  memory.tasks=[...tasks.values()].sort((first,second)=>first.fleetId.localeCompare(second.fleetId));
  memory.failures=memory.failures.slice(-64);
  const summary=selected.length?`adaptive-v1：${selected.slice(0,5).map(candidate=>candidate.label).join('；')}。${actions.length}项计划；300日风险${Math.round(risk)}。`:'adaptive-v1：暂不行动；现有可知方案未优于等待或未满足安全及通行条件。';
  return {actions,memory,report,summary};
}
