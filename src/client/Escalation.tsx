import { governed } from '../shared/governance.js';
import { GovernanceDetail } from './Governance.js';
import { balancedRules, civilizationScore } from '../shared/balance.js';
import type { GameState } from '../shared/types.js';
import { ESCALATION, revised, warReasons } from '../shared/escalation.js';
import { relationship } from '../shared/diplomacy.js';
import { scoreBreakdown } from '../shared/scoring.js';

export function EscalationPanel({ state, pair }: { state: GameState; pair?: string[] }) {
  if (!revised(state)) return null;
  const relevant = (ids: string[]) => !pair || ids.every(id => pair.includes(id));
  return <section className="escalation-panel civil-summary"><h3>总体战入口 · {state.rulesRevision}</h3>
    <p>条约内不可宣战；宿敌与成熟资格只在无条约的和平日消退。</p>
    {Object.values(state.rivalries ?? {}).filter(item => relevant(item.factions)).map(item => <div className="rivalry-status" key={item.factions.join(':')}>
      <strong>{item.factions.map(id => state.factions[id].name).join(' / ')} · {item.warIds.length >= ESCALATION.rivalryWars ? '宿敌' : '战争累计'} {item.warIds.length} / 3</strong>
      <small>自由和平 {item.freePeaceDays} / 1080日 · 条约剩余 {Math.max(0, (relationship(state, ...item.factions)?.pactUntil ?? 0) - state.day)}日</small>
      <small>下次最早宣战：第{Math.max(state.day, relationship(state, ...item.factions)?.pactUntil ?? 0)}日（仍须和平及有效理由）</small>
    </div>)}
    {(state.conquests ?? []).filter(item => relevant([item.actor, item.target])).slice(-16).reverse().map(item => <div className="conquest-status" key={item.id}>
      <strong>{state.factions[item.actor].name} → {state.factions[item.target].name}：{item.endedDay !== undefined ? item.outcome : state.day < item.readyDay ? '征服准备中' : '征服资格成熟'}</strong>
      <small>{item.reason}</small>
      {item.endedDay === undefined && <><small>准备剩余 {Math.max(0, item.readyDay - state.day)}日 · 成熟资格剩余 {ESCALATION.readinessDays - item.freePeaceDays}个自由和平日</small><small>最早可宣战第{Math.max(state.day, item.readyDay, relationship(state, item.actor, item.target)?.pactUntil ?? 0)}日；需仍然法理接壤</small><small>已付300矿物／100食物／10凝聚力；准备期间凝聚力−2/100日，不退款</small></>}
    </div>)}
    {pair && pair.flatMap(actor => warReasons(state, actor).filter(item => pair.includes(item.target)).map(item => <small key={actor + item.id}>{state.factions[actor].name}理由 {item.kind} · 第{item.availableDay}日起可用 · {item.usable ? '资格有效' : '情报未确认接壤'}{item.remainingFreePeaceDays === null ? item.active ? ' · 原因仍存在' : ' · 第' + item.expiresDay + '日失效' : ' · 剩余' + item.remainingFreePeaceDays + '个自由和平日'}</small>))}
  </section>;
}
export function ScoreDetail({ state, actor }: { state: GameState; actor: string }) {
  const score = scoreBreakdown(state, actor);
  const penalty=civilizationScore(state,actor).responsibilityPenalty;
  return <details className="score-detail civil-summary"><summary>{state.factions[actor].name}评分分解 · {score.total.toFixed(governed(state)?3:1)}</summary>
    <GovernanceDetail state={state} actor={actor} /><p>法理星系 {score.systems} · 殖民地 {governed(state)?score.colonies.toFixed(3):score.colonies} · 人口 {governed(state)?score.population.toFixed(3):score.population}</p>
    {penalty!==undefined&&<p>救援责任当前扣分 {penalty.toFixed(1)} /300（已从文明成果扣除，最低0；历史任期成果保留）</p>}
    <p>舰队 {score.fleet.toFixed(1)}（权重{revised(state) ? '0.5' : '1'}） · {('reserves' in score ? '储备（上限400）' : '矿物')} {('reserves' in score ? score.reserves : score.minerals).toFixed(1)}</p>
    {balancedRules(state) && <p>文明成果 {score.civilization} / 1500 · 乌托邦任期 {civilizationScore(state, actor).utopia} · 信仰任期 {civilizationScore(state, actor).faith} · 主圣地 {civilizationScore(state, actor).main} · 附属 {civilizationScore(state, actor).secondary} · 圣地暂失 {civilizationScore(state, actor).unavailableHoly}。任期永久去重；圣地按当前控制计分；吞并领土成果在整合完成后计入。</p>}
    {revised(state) && <><p>领土成果 {score.territory} · 非领土目标 {score.objectives} / 500</p><small>领土成果每星系仅一次，需仍持有；非领土按对手、星系、目标类型去重。</small>{(state.warAchievements ?? []).filter(item => item.actor === actor).map(item => <small key={[item.target, item.systemId, item.type].join(':')}>{item.systemId} · {item.type} · 第{item.day}日 · {item.warId}</small>)}</>}
  </details>;
}
