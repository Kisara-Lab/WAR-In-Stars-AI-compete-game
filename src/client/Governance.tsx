import { governed, governanceView } from '../shared/governance.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import type { GameState } from '../shared/types.js';
import type { War } from '../shared/v4.js';
export function GovernanceDetail({state,actor}:{state:GameState;actor:string}) {
  if(!governed(state)||!state.factions[actor].welfare)return null;
  const g=governanceView(state,actor),f=g.factors;
  return <div className="governance-detail"><strong>治理质量 Q {(g.quality*100).toFixed(3)}%</strong><p>社会资产原始 {g.rawSocial.toFixed(3)} → 折算 {g.adjustedSocial.toFixed(3)}；观察 {g.days}/720 日。{g.note}</p><small>本步待遇 {f.treatment/1000000} × 兑现 {f.welfare/1000000} × 供应 {f.supply/1000000} × 稳定 {f.stability/1000000}。仅影响人口与殖民地分，不额外重复扣信仰危机或军方不满。</small></div>;
}
export function SettlementDetail({state,war}:{state:GameState;war:War}) {
  if(!governed(state)||war.endedDay!==undefined)return null;
  return <details><summary>停战结算预览</summary>{war.factions.filter(a=>!!state.factions[a].welfare).map(actor=>{
    const p=settlementPreview(state,actor,war)!;
    return <div key={actor}><strong>{state.factions[actor].name}</strong><p>无条件停战归还：{p.unconditional.returnOccupations.map(s=>`${s.systemId}→${s.to}`).join('、')||'无'}；保留正式吞并：{p.unconditional.retainAnnexations.join('、')||'无'}；放弃目标：{p.unconditional.abandonedGoals.join('、')||'无'}。</p><p>条约到第{p.unconditional.treatyUntil}日；{p.unconditional.responsibility}</p>{p.enforced.goals.map(g=><p key={g.systemId}>{g.systemId} {g.heldDays}/{g.requiredDays}日：{g.result}</p>)}<small>{p.warning}</small>{p.extraction&&<p>{p.extraction.unconditional} {p.extraction.enforced}</p>}</div>;
  })}</details>;
}
