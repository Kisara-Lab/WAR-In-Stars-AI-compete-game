import { EmergencyPanel } from './Emergency.js';
import { useEffect, useState } from 'react';
import { CIVILIZATION_NAMES, WELFARE, civilizationView, modern } from '../shared/civilization.js';
import { cohesionBreakdown } from '../shared/civil.js';
import type { GameState } from '../shared/types.js';
import { responsible, responsibilityView } from '../shared/responsibility.js';

function ResponsibilityPanel({state,actor}:{state:GameState;actor:string}) {
  const v=responsibilityView(state,actor);if(!v)return null;
  const d=v.own;
  return <details open aria-label="文明责任与民生救援"><summary>创教名额、文明责任与民生救援</summary>
    <p>全图两个永久创教资格；须探索、法理拥有并实际控制。失守和淘汰不释放，附属圣地不能创教。</p>
    <p>已知登记：{v.founders.map(f=>`${f.planetId} → ${state.factions[f.actor].name}`).join('；')||'尚无已知登记'}</p>
    <p>本国责任起算第{d?.startedDay}日；成果满足至第{d?.satisfiedUntil}日；累计逾期{d?.overdueDays}日。{d?.last?.actionable?'存在可行动路径':d?.last?.blocked.join('；')||'尚未结算责任'}</p>
    <p>军方不满 {d?.dissatisfaction.toFixed(1)} /100；凝聚力 {v.militaryUnity}/100日。救援责任当前扣分 {d?.rescuePenalty.toFixed(1)} /300；{d?.ignored?'灯塔奖励暂停、当期评估不合格':'没有未回应惩罚'}。</p>
    <table><thead><tr><th>民生报告</th><th>待遇</th><th>兑现等级</th><th>日期／困境</th></tr></thead><tbody>{v.reports.map(r=><tr key={r.target}><td>{state.factions[r.target].name}</td><td>{WELFARE[r.welfare as keyof typeof WELFARE]?.name}</td><td>{{at_least_90:'至少90%', '50_to_90':'50%～90%',below_50:'低于50%'}[r.delivery]}</td><td>{r.day}日 / {r.distressed?'持续困境':'无持续困境'}</td></tr>)}</tbody></table>
    {v.concerns.map(c=><p key={c.id}>关注 {c.id}：{c.closedDay!==undefined?`第${c.closedDay}日解除`:`第${c.openedDay}日起；本方回应截止${(d?.responses[c.id]?.knownDay??c.known[actor]??state.day)+360}日`}</p>)}
    {v.aid.map(a=><p key={a.id}>援助 {a.id}：{a.outcome??(a.acceptedDay===undefined?'待接受':'福利专用托管')}；剩余电/矿/粮 {['energy','minerals','food'].map(k=>(a.remaining[k as keyof typeof a.remaining]!).toFixed(1)).join('/')}；改善 {a.improvedDays}日，截止{a.expiresDay}日。</p>)}
    {v.reforms.map(r=><p key={r.id}>改革 {r.id}：{r.breachedDay!==undefined?`第${r.breachedDay}日违约，理由至${r.breachExpiresDay}日`:r.effective?'实际履责完成':r.acceptedDay!==undefined?'监督中':'待接受'}；连续合格 {r.qualifiedDays}/360日；截止{r.expiresDay??r.offerUntil}日。</p>)}
    {d?.extractionLast?.details.map(item=><p key={item.eventId}>停止征收责任 · {item.eventId}：{item.reason}（第{d.extractionLast!.day}日）</p>)}
    <small>只有实际支付、持续改善或兑现战争目标才算进展；工具接受与世界结算分开记录。</small>
  </details>;
}

function ComparisonDetails({comparison:c}:{comparison:any}) {
  return <div className="decision-comparison-details">
    <h4>资源用途与加工瓶颈</h4>
    {c.emergencyEconomy&&<details open><summary>特殊托底与退出对照</summary><p>{c.emergencyEconomy.assumptions}</p><table><thead><tr><th>当前资产试算</th><th>电 / 矿 / 粮库存变化，每100日</th><th>福利兑现</th></tr></thead><tbody>{[['current','按当前托底'],['withoutSubsidy','撤去补助']].map(([key,label])=><tr key={key}><td>{label}</td><td>{['energy','minerals','food'].map(k=>(c.emergencyEconomy[key].resourcesPer100[k]??0).toFixed(1)).join(' / ')}</td><td>{((c.emergencyEconomy[key].welfareFraction??0)*100).toFixed(1)}%</td></tr>)}</tbody></table></details>}
    <table><thead><tr><th>资源</th><th>当前／在建完成后净收入</th><th>用途</th></tr></thead><tbody>{c.resourcePurposes?.resources?.map((r:any)=><tr key={r.resource}><td>{r.resource}</td><td>{r.netPer100.toFixed(1)} / {r.afterQueuedNetPer100.toFixed(1)}</td><td>{r.marginalUse}{r.depletionDays!==null?`；静态耗尽约${r.depletionDays.toFixed(0)}日`:''}</td></tr>)}</tbody></table>
    {c.resourcePurposes&&<p>储备分余量 {c.resourcePurposes.reserveScoreRemaining.toFixed(1)} / 400。步初扣除维护与福利后可加工矿物 {c.resourcePurposes.processing.availableOpeningMineralsPerStep.toFixed(1)}；当前／在建完工合金产出 {c.resourcePurposes.processing.alloyOutput.toFixed(1)} / {c.resourcePurposes.processing.afterQueued.alloyOutput.toFixed(1)}（每100日）。已排队船只已付材料。</p>}
    <h4>文明路线：当前收益与可执行准备</h4>
    {c.pathwayForecasts?.variants?.filter((v:any)=>v.kind!=='policy').map((v:any)=><details key={v.choice}><summary>{v.choice} · {v.allowed?'当前条件允许':'存在前置条件'}</summary><p>{typeof v.blocker==='string'?v.blocker:Array.isArray(v.blocker)?v.blocker.join('；'):''}</p>{v.setup&&<p>{JSON.stringify(v.setup)}</p>}{v.capability&&<p>{JSON.stringify(v.capability)}</p>}<p>{v.projection?.assumptions}</p><table><thead><tr><th>未来日数</th><th>电／矿／粮／合金库存</th><th>失约日数</th></tr></thead><tbody>{v.projection?.horizons?.map((h:any)=><tr key={h.days}><td>{h.days}</td><td>{['energy','minerals','food','alloys'].map(k=>(h.resources[k]??0).toFixed(1)).join(' / ')}</td><td>{h.unpaidDays}</td></tr>)}</tbody></table></details>)}
    <h4>已知施工条件与探索</h4>
    {c.actionability?.exploration?.map((p:any)=><p key={p.id}>{p.systemId}：探索预计第{p.completionDay}日完成；{p.reveals}</p>)}
    <table><thead><tr><th>星系</th><th>情报日期</th><th>建基地</th></tr></thead><tbody>{c.actionability?.systems?.map((s:any)=><tr key={s.systemId}><td>{s.systemId}</td><td>{s.lastSeenDay<0?'未知':s.lastSeenDay}</td><td>{s.base.allowed?'已知条件允许，结算复核':s.base.blocker}</td></tr>)}</tbody></table>
  </div>;
}

export function Institutions({state,actor}:{state:GameState;actor:string}) {
  const [comparison,setComparison]=useState<any>(null),[error,setError]=useState('');
  useEffect(()=>{setComparison(null);setError('');},[state.id,state.round,actor]);
  if(!modern(state))return null;
  const view=civilizationView(state,actor),f=state.factions[actor],w=f.welfare!,detail=cohesionBreakdown(state,actor);
  const values=(r:Record<string,number>)=>`电 ${r.energy.toFixed(1)} / 矿 ${r.minerals.toFixed(1)} / 粮 ${r.food.toFixed(1)}`;
  return <section className="civil-summary institutions" aria-label="文明制度与福利">
    <strong>永久路线 · {CIVILIZATION_NAMES[f.civilization?.choice??'secular']}</strong>
    <small>{view.permanent}</small>
    <ResponsibilityPanel state={state} actor={actor}/><EmergencyPanel state={state} actor={actor}/>
    {responsible(state)&&Object.keys(f.failedOrders??{}).length>0&&<details open><summary>已提交命令的实际失败记录</summary>{Object.values(f.failedOrders??{}).map(r=><p key={r.type+':'+r.target}>{r.type} → {r.target}：累计失败{r.count}次，最近第{r.day}日。{r.reason}；旧情报未确认可施工，先通过合法舰队观察或正常LRS刷新。</p>)}<small>计划摘要和工具预留不代表世界执行成功；失败建设不计已有项目。</small></details>}
    <strong>民众待遇 · {WELFARE[w.choice].name}</strong>
    <small>每100日应付 {values(view.billPer100.due)} · 法理人口 {view.billPer100.population}</small>
    <small>最近十日兑现 {w.last?`${(w.last.fraction*100).toFixed(1)}%`:'尚未结算'}{view.welfare?.last?` · 实付 ${values(view.welfare.last.paid)}`:''}</small>
    <small>福利凝聚力净贡献 {(detail.welfare??0).toFixed(2)} /100日 · 失约惩罚 {(-6*(1-(w.last?.fraction??1))).toFixed(2)}；工业贡献独立计算</small>
    <small>{['utopia','theocracy'].includes(f.civilization!.choice)?'永久制度锁定待遇':`可调整日期：第${Math.max(state.day,view.nextWelfareDay)}日`}{w.last?.reasons.length?` · ${w.last.reasons.join('；')}`:''}</small>
    <details><summary>乌托邦资格与灯塔</summary><p>最高待遇连续 {w.highestSince===null?0:state.day-w.highestSince} /720日；近72步达标 {view.qualifiedIntervals}/72，须至少65步。</p><p>{view.eligibility.utopia.allowed?'当前可以永久确立':view.eligibility.utopia.blockers.join('；')}</p><p>允许宣称割地、有限战争和持合法理由的总体战；永久乌托邦只禁止征服准备，参战本身不使评估失格。</p><p>连续合格 {f.beacon?.streak??0} 期；条件奖励{view.operating?'生效':'未生效'}：增长×1.15、凝聚力+2，灯塔另+1/+2；无资源折损或灯塔产出倍率。</p></details>
    <details><summary>军国与国教</summary><p>军国战力×1.10、造舰×1.15、全舰维护×1.10、工业惩罚×1.25；征服准备180日、150矿、50粮、5凝聚力。{responsible(state)?'仅可选均衡小康、基础保障、维持生存。':'可付最高福利，但不能转为乌托邦。'}</p><p>国教锁定教廷保障；失约额外危机+2×未兑现比例/100日。安全已祝圣主圣地且危机低于20，全资源产出×1.10。永久主圣地不可迁移。</p></details>
    <details onToggle={event=>{if(event.currentTarget.open) {setError('');fetch(`/api/matches/${state.id}/rounds/${state.round}/comparison/${actor}`).then(async r=>{if(!r.ok)throw Error('比较数据暂不可用');setComparison(await r.json());}).catch(e=>setError(String(e)));}}}><summary>统一决策比较与720／1440日预测</summary><p>与AI首轮输入、查询工具共用结果。仅本方已知经济，冻结控制权与外部战争；不是收益保证。</p>{error&&<p>{error}</p>}{comparison&&<><ComparisonDetails comparison={comparison}/><h4>政策每100日净收支</h4><table><thead><tr><th>政策</th><th>电/矿/粮/合金</th><th>凝聚力</th></tr></thead><tbody>{comparison.policies?.map((p:any)=><tr key={p.choice}><td>{p.name}</td><td>{[p.net.energy,p.net.minerals,p.net.food,p.net.alloys].map((n:number)=>n.toFixed(1)).join(' / ')}</td><td>{p.effectiveUnityChange.toFixed(1)}</td></tr>)}</tbody></table><h4>已提交计划的条件性预测</h4><table><thead><tr><th>未来日数</th><th>库存 电/矿/粮/合金</th><th>人口</th><th>短缺/失约日数</th></tr></thead><tbody>{comparison.forecast?.horizons?.map((h:any)=><tr key={h.days}><td>{h.days}</td><td>{h.resources?[h.resources.energy,h.resources.minerals,h.resources.food,h.resources.alloys??0].map((n:number)=>n.toFixed(1)).join(' / '):'—'}</td><td>{h.population}</td><td>{h.shortageDays} / {h.unpaidDays}</td></tr>)}</tbody></table><h4>已付款项目与岗位</h4>{comparison.industry?.map((p:any)=><p key={p.planetId}>{p.planetId}：现有需求 {p.jobs} / 人口 {p.population}；在建另需 {p.reservedJobs}；在建完工后需求 {p.afterQueuedBuildings?.jobs}。建筑选择含暂不建设。</p>)}</>}<details><summary>完整选项、前置条件与依据</summary><pre style={{maxHeight:420,overflow:'auto',whiteSpace:'pre-wrap'}}>{comparison?JSON.stringify(comparison,null,2):'展开后读取本回合比较'}</pre></details></details>
  </section>;
}
