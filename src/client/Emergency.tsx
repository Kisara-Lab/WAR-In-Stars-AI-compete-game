import { emergencyView } from '../shared/emergency.js';
import type { GameState } from '../shared/types.js';

export function EmergencyPanel({state,actor}:{state:GameState;actor:string}) {
  const view=emergencyView(state,actor);if(!view)return null;
  const own=view.own;
  const values=(v:Record<string,number>)=>['energy','minerals','food'].map(k=>(v[k]??0).toFixed(2)).join(' / ');
  return <details className="emergency-panel" open aria-label="什四税与停止通牒"><summary>什四税、停止通牒与受监督恢复</summary>
    <p>{view.explanation}</p>
    <p>{own?`本局资格已用 · ${own.phase==='extraction'?'强制征收':own.phase==='recovery'?'受监督恢复':'已到期'} · 原截止第${own.expiresDay}日 · 剩余${own.remainingDays}日` : view.available?'国教可启用一次1800日救急':'仅永久国教可启用'}</p>
    {own?.last&&<><table><thead><tr><th>最近十日</th><th>电力 / 矿物 / 食物</th></tr></thead><tbody>
      <tr><td>正常生产</td><td>{values(own.last.normalProduction)}</td></tr>
      <tr><td>特殊补助（无资源来源）</td><td>{values(own.last.grant)}</td></tr>
      <tr><td>可托底基础开支</td><td>{values(own.last.eligible)}</td></tr>
      <tr><td>可交付福利账单</td><td>{values(own.last.welfare)}</td></tr>
      <tr><td>未覆盖基础维护</td><td>{values(own.last.uncovered)}</td></tr>
    </tbody></table><p>累计补助 {values(own.totalGrant)}；恢复补助比例 {(own.fade*100).toFixed(1)}%。合金、加工、维修和订单另行支付；停止后舰船补助取消。</p></>}
    {own&&<p>征收期间单步治理Q最高0.50，重叠的稳定信仰期不合格。恢复连续合格 {own.qualifiedDays}/360日；补助归零后需独立维持收支。</p>}
    {view.events.map(e=><section key={e.id}><strong>{state.factions[e.target]?.name} · {e.id}</strong><p>{e.stoppedDay===undefined?`征收截止${e.expiresDay}日；本方提出要求期限${e.requestDeadline}日`:`第${e.stoppedDay}日停止；${e.fulfilledDay===undefined?'等待实际恢复':'已完成持续恢复'}`}</p>{e.demands.map(d=><p key={d.id}>停止要求 {d.id} · {state.factions[d.actor]?.name} · 回应截止{d.deadline}日 · {d.acceptedDay!==undefined?'已接受':d.rejectedDay!==undefined?'已拒绝':'待回应'}。</p>)}{e.reformId&&<p>关联监督协议 {e.reformId}</p>}</section>)}
    <small>条约不妨碍提出要求，但仍禁止宣战；无条件停战不会强制停止征收，空宣战不算履责。</small>
  </details>;
}
