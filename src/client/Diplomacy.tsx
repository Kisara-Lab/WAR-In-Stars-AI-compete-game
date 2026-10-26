import { EscalationPanel } from './Escalation.js';
import { useState } from 'react';
import type { GameState } from '../shared/types.js';
import { factionIds } from '../shared/rules.js';
import { relationKey, relationLabel, relationship } from '../shared/diplomacy.js';

export function DiplomacyPanel({ state }: { state: GameState }) {
  const ids = factionIds(state);
  const [selected, setSelected] = useState('');
  const relations = Object.values(state.relations ?? {});
  const relation = state.relations?.[selected] ?? relations[0];
  if (!relation) return <p>旧版历史记录：双方永久战争。恢复后将在新分支启用外交。</p>;
  return <div className="diplomacy-layout">
    <div className="diplomacy-table-wrap"><table className="diplomacy-table" aria-label="外交关系矩阵"><thead><tr><th>领土方 ↓ / 访客 →</th>{ids.map(id => <th key={id} style={{ color: state.factions[id].color }}>{state.factions[id].name}</th>)}</tr></thead><tbody>{ids.map(host => <tr key={host}><th style={{ color: state.factions[host].color }}>{state.factions[host].name}</th>{ids.map(visitor => {
      const pair = relationship(state, host, visitor);
      return <td key={visitor}>{host === visitor ? '—' : <button className={`relation-cell ${pair?.status ?? 'unknown'}`} disabled={!pair} onClick={() => setSelected(relationKey(host, visitor))}><strong>{pair ? relationLabel(pair, state.day) : '未获知'}</strong><small>{state.factions[host].eliminatedDay !== undefined || state.factions[visitor].eliminatedDay !== undefined ? '势力已淘汰' : pair?.status === 'war' ? '战时可进入' : pair?.status === 'peace' ? pair.access[host] ? '→ 允许访客进入' : '× 边境关闭' : pair ? '接触前可通行' : '第三方外交情报不可见'}</small></button>}</td>;
    })}</tr>)}</tbody></table></div>
    <div className="diplomacy-detail"><h3>{relation.factions.map(id => state.factions[id].name).join(' / ')}</h3><p>{relationLabel(relation, state.day)}</p><p>首次接触：{relation.contactDay === null ? '尚未发生' : `第 ${relation.contactDay} 日`}</p><p>确认联系：{relation.confirmed.map(id => state.factions[id].name).join('、') || '尚未确认'}</p>{relation.pactUntil !== null && <p>条约至第 {relation.pactUntil} 日 · 剩余 {Math.max(0, relation.pactUntil - state.day)} 日</p>}{relation.factions.map(host => <p key={host}>{state.factions[host].name}：{relation.access[host] ? '授予对方通行权' : '未授予通行权'}</p>)}{Object.entries(relation.offers).map(([actor, offer]) => <p key={actor}>待回应：{state.factions[actor].name}提议停战，等待{state.factions[relation.factions.find(id => id !== actor)!].name}；剩余 {offer.expiresDay - state.day} 日</p>)}{!Object.keys(relation.offers).length && <p>暂无待回应的停战提议</p>}<EscalationPanel state={state} pair={relation.factions} /><small>通行权与停战、互不侵犯分别决定；外交由 AI 提交。</small></div>
  </div>;
}
