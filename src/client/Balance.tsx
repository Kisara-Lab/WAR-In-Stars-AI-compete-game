import { modern } from '../shared/civilization.js';
import { religionEligibility } from '../shared/religion-options.js';
import { BALANCE, balancedRules, civilizationScore, holyCooperation, integrating, warBurden } from '../shared/balance.js';
import { policyComparison } from '../shared/comparison.js';
import type { GameState, StarSystem } from '../shared/types.js';
import { occupied } from '../shared/v4.js';

export function BalanceSummary({ state, actor }: { state: GameState; actor: string }) {
  if (!balancedRules(state)) return null;
  const burden = warBurden(state, actor);
  const faction = state.factions[actor];
  const score = civilizationScore(state, actor);
  const candidates = state.systems.filter(system => faction.surveyed.includes(system.id)).flatMap(system => system.planets.filter(planet => planet.holyCandidate));
  return <div className="civil-summary balance-summary"><strong>{modern(state)?'V5':'4.2'} 战争成本与文明成果</strong>
    <small>总体战主动 {burden.offensive} / 防御 {burden.defensive} · 全舰维护 ×{burden.multiplier.toFixed(2)}</small>
    <small>每100日额外电力 {burden.extra.energy.toFixed(1)} / 矿物 {burden.extra.minerals.toFixed(1)} · 战争凝聚力 {burden.unity}</small>
    <small>文明成果 {score.total} / {score.cap}：乌托邦任期 {score.utopia}、信仰任期 {score.faith}、主圣地 {score.main}、附属 {score.secondary}；失守暂失 {score.unavailableHoly}</small>
    {score.responsibilityPenalty!==undefined&&<small>救援责任当前扣分 {score.responsibilityPenalty.toFixed(1)} /300；已从文明分扣除，不删除历史成果。</small>}
    <small>圣地社会协作：{holyCooperation(state, actor) ? `生效 · 全资源产出×${modern(state)?'1.10':'1.05'}` : '未生效 · 需主圣地祝圣、拥有且控制、危机低于20'}</small>
    {faction.stableFaith && <small>稳定信仰本届：{faction.stableFaith.qualifiedDays} / {faction.stableFaith.totalDays} 日合格 · 需要完整720日且达标90%{!faction.stableFaith.wholeTerm ? ' · 本届非完整国教任期' : ''}</small>}
    {!faction.faith && <small>立教条件：已发现候选 {candidates.map(planet => `${planet.name}：${religionEligibility(state, actor, planet.id) ?? '可立教'}`).join('；') || '无'}；{faction.policy?.choice === 'utopia' || faction.policy?.next?.choice === 'utopia' ? '当前或预约乌托邦阻止立教' : '需合法可达路径，主圣地不可迁移，永久禁用乌托邦'}</small>}
    <details className="policy-comparison"><summary>政策收支对照（每100日静态估算）</summary><p>当前资产、凝聚力与短缺固定；不保证未来供应，不含维修和战损。封顶后的正凝聚力不转换成资源。</p><table><thead><tr><th>政策</th><th>净电/矿/粮</th><th>凝聚力/实际</th><th>人口进度</th></tr></thead><tbody>{policyComparison(state, actor).map(option => <tr key={option.choice}><td>{option.name}{!option.allowed ? '（国教禁止）' : ''}</td><td>{option.net.energy.toFixed(1)}/{option.net.minerals.toFixed(1)}/{option.net.food.toFixed(1)}</td><td>{option.cohesion.total.toFixed(1)}/{option.effectiveUnityChange.toFixed(1)}</td><td>×{option.populationGrowth}</td></tr>)}</tbody></table><p>{modern(state)?'V5无旧乌托邦资源倍率；政策与永久路线独立。福利、基础维护后再加工，预测含福利支出。':'乌托邦电矿倍率：普通0.85、灯塔一级0.90、二级0.95；凝聚力+8/+9/+10，合格任期100文明分。'}战争本身不使稳定信仰任期失格。</p></details>
  </div>;
}
export function AnnexationDetail({ state, system }: { state: GameState; system: StarSystem }) {
  if (!balancedRules(state) || !system.annexation) return null;
  const active = integrating(system);
  return <p className="annexation-detail">吞并整合：{active ? `剩余 ${BALANCE.annexationDays - system.annexation.controlledDays} 个实际控制日` : '已完成'} · {occupied(system) ? '临时占领，整合计时暂停；产出×0.25，人口和建设暂停' : active ? '生产/建设/人口×0.50；维护全额，领土成果延迟' : '正常生产；领土成果计分'}<small>独立于思想整合；探索、殖民和祝圣工期不变。</small></p>;
}
