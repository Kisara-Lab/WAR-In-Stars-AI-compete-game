import type { LiveSnapshot } from '../shared/types.js';

export function ScriptStrategyPanel({snapshot,viewer}:{snapshot:LiveSnapshot;viewer:string}) {
  if(!snapshot.state.config.scriptStrategy?.startsWith('adaptive-'))return null;
  return <section className="civil-summary script-strategy" aria-label="智能脚本规划">
    <h3>智能脚本 {snapshot.state.config.scriptStrategy} · 模型请求与 token 为 0</h3>
    {Object.entries(snapshot.state.factions).filter(([actor])=>!viewer||actor===viewer).map(([actor,faction])=>{
      const decision=snapshot.lastDecisions?.[actor], report=decision?.scriptReport, memory=faction.scriptMemory;
      return <details key={actor}><summary>{faction.name} · {memory?.goal?.kind??'等待'} · {memory?.goal?.target??'尚未规划'}</summary>
        <p>目标阶段：{memory?.goal?.stage??'—'}；截止日 {memory?.goal?.deadline??'—'}；最后进展轮 {memory?.goal?.lastProgressRound??'—'}</p>
        <p>候选 {report?.candidates??0}/256 · 详细预测 {report?.forecasts??0}/24 · 整批校验 {report?.validations??0}/3 · 决策 {Math.round(decision?.metrics.durationMs??0)} ms{report?.exhausted?' · 搜索预算已截断':''}</p>
        <p>{report?.assumptions}</p>
        {report?.performance&&<p>阶段耗时与缓存：{Object.entries(report.performance).map(([key,value])=>`${key} ${value.toFixed(1)}`).join(' · ')}</p>}
        {report?.comparisons&&<details><summary>文明、战争路径与传感覆盖比较</summary><pre>{JSON.stringify(report.comparisons,null,2)}</pre></details>}
        <strong>计划选择</strong><ul>{report?.selected.map(item=><li key={item.id}>{item.label}</li>)}</ul>
        <strong>前三个未选方案</strong><ul>{report?.alternatives.map(item=><li key={item.id}>{item.label}：收益 {item.value.toFixed(1)}，风险 {item.risk.toFixed(1)}；{item.reason}；情报日 {item.evidenceDays.join('、')}</li>)}</ul>
        <strong>舰队任务</strong><ul>{memory?.tasks.map(task=><li key={task.fleetId}>{task.fleetId} → {task.target} · {task.role}</li>)}</ul>
        <p>工具接受：{decision?.actions.length??0} 条。接受仅代表本方校验通过；世界执行以共同结算记录为准。</p>
        <ul>{snapshot.state.events.filter(event=>event.type==='order'&&event.audience.includes(actor)&&event.round===snapshot.state.round).map(event=><li key={event.id}>{event.text}</li>)}</ul>
      </details>;
    })}
  </section>;
}
