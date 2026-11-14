import type { LiveSnapshot } from '../shared/types.js';
import { ADAPTIVE_V3 } from '../shared/adaptive.js';

export function ScriptStrategyPanel({snapshot,viewer}:{snapshot:LiveSnapshot;viewer:string}) {
  if(!snapshot.state.config.scriptStrategy?.startsWith('adaptive-'))return null;
  return <section className="civil-summary script-strategy" aria-label="智能脚本规划">
    <h3>智能脚本 {snapshot.state.config.scriptStrategy} · 模型请求与 token 为 0</h3>
    {Object.entries(snapshot.state.factions).filter(([actor])=>!viewer||actor===viewer).map(([actor,faction])=>{
      const decision=snapshot.lastDecisions?.[actor], report=decision?.scriptReport, memory=faction.scriptMemory;
      const limits=report?.version==='adaptive-v3'?ADAPTIVE_V3.profiles[snapshot.state.config.scriptSearchProfile??'standard']:{candidates:256,forecasts:24};
      const trajectory=report?.projections?.find(projection=>projection.id===report.selectedProjection)?.trajectory??[];
      return <details key={actor}><summary>{faction.name} · {memory?.goal?.kind??'等待'} · {memory?.goal?.target??'尚未规划'}</summary>
        <p>目标阶段：{memory?.goal?.stage??'—'}；截止日 {memory?.goal?.deadline??'—'}；最后进展轮 {memory?.goal?.lastProgressRound??'—'}</p>
        <p>候选 {report?.candidates??0}/{limits.candidates} · 详细预测 {report?.forecasts??0}/{limits.forecasts} · 整批校验 {report?.validations??0}/3 · 决策 {Math.round(decision?.metrics.durationMs??0)} ms{report?.exhausted?' · 搜索预算已截断':''}</p>
        {report?.search&&<details><summary>组合搜索 · {report.search.profile} · {report.search.evaluations}次草稿评估 · 深度{report.search.depth}</summary><pre>{JSON.stringify(report.search.combinations,null,2)}</pre></details>}
        {memory?.campaign&&<p>战役：{memory.campaign.opponent} / {memory.campaign.target} · {memory.campaign.stage} · {memory.campaign.blockers.join('；')}</p>}
        {memory?.recovery&&<p>补助退出修复：截止 {memory.recovery.deadline} 日；无补助福利兑现 {(memory.recovery.welfareFraction*100).toFixed(1)}%；基础供应缺口 {Object.entries(memory.recovery.shortages).filter(([,short])=>short).map(([resource])=>resource).join('、')||'无'}。不延长原期限。</p>}
        {trajectory.length>0&&<figure><figcaption>已选组合：治理 Q（青）与凝聚力（橙），{trajectory[0].day}—{trajectory.at(-1)!.day}日；战争成功未计入</figcaption><svg role="img" aria-label="治理风险预测曲线" viewBox="0 0 400 120"><path d="M10 10V110H390" fill="none" stroke="currentColor"/>{(['quality','unity'] as const).map((key,index)=><polyline key={key} fill="none" stroke={index?'#ffac75':'#56dfd3'} strokeWidth="2" points={trajectory.map((row,position)=>`${10+position*380/Math.max(1,trajectory.length-1)},${110-(key==='quality'?row.quality*100:row.unity)}`).join(' ')}/>)}</svg></figure>}
        {report?.version==='adaptive-v3'&&<details><summary>治理及责任情景（成功为条件假设）</summary><pre>{JSON.stringify(report.projections,null,2)}</pre></details>}
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
