import { Institutions } from './Institutions.js';
import { modern, V5_POLICIES } from '../shared/civilization.js';
import { industrial, capacity, EXTRA } from '../shared/industry.js';
import { BalanceSummary } from './Balance.js';
import { BALANCE, balancedRules } from '../shared/balance.js';
import { FaithSummary, PlanetFaith } from './Civilization.js';
import { controller } from '../shared/v4.js';
import { cohesionBreakdown, planetCohesion, POLICIES, policyWindow, sensorCoverage } from '../shared/civil.js';
import { RULES, STRUCTURES } from '../shared/rules.js';
import type { GameState, Planet, StarSystem } from '../shared/types.js';

export function CivilSummary({ state, factionId }: { state: GameState; factionId: string }) {
  if (state.version < 3) return <small>旧规则历史快照</small>;
  const faction = state.factions[factionId];
  const detail = cohesionBreakdown(state, factionId);
  const policy = faction.policy;
  const term = Math.floor(state.day / RULES.policyDays);
  return <div className="civil-summary">
    <strong>{POLICIES[policy?.choice ?? 'none'].name}</strong> · 任期剩余 {(term + 1) * RULES.policyDays - state.day} 日
    <small>{policy?.explicit ? 'AI 明确选择' : policy?.locked ? '未提交，默认跳过' : '等待首届选择'}{policyWindow(state, factionId) !== null ? ' · 政策选择窗口开放' : ''}</small>
    {policy?.next && <small>下届：{POLICIES[policy.next.choice].name} · 第{policy.next.term * RULES.policyDays}日生效</small>}
    <details><summary>凝聚力 {detail.total >= 0 ? '+' : ''}{detail.total.toFixed(2)} / 100 日</summary><p>基础 {detail.base.toFixed(2)} · 民生及矿业 {detail.buildings.toFixed(2)} · 政策 {detail.policy.toFixed(2)} · 短缺 {detail.shortage.toFixed(2)} · 信仰 {detail.religion.toFixed(2)} · 外国影响 {detail.foreign.toFixed(2)} · 灯塔 {detail.beacon.toFixed(2)} · 总体战 {(detail.war ?? 0).toFixed(2)}{state.rulesRevision && <> · 征服准备 {(detail.conquest ?? 0).toFixed(2)}</>}</p><p>正收益供应倍率 ×{detail.factor}；地表贡献按人口加权。当前值为下一步估计，逐步实绩见审计。</p></details>
    <Institutions state={state} actor={factionId} /><BalanceSummary state={state} actor={factionId} /><FaithSummary state={state} factionId={factionId} />
  </div>;
}

export function PlanetCivil({ state, planet }: { state: GameState; planet: Planet }) {
  if (state.version < 3) return null;
  const detail = planetCohesion(planet, industrial(state) ? state.day : undefined);
  const contribution = planet.ownerId ? cohesionBreakdown(state, planet.ownerId).planets.find(item => item.planetId === planet.id) : null;
  return <><PlanetFaith state={state} planet={planet} /><details className="civil-summary"><summary>矿场 {detail.mines.toFixed(1)} / {industrial(state) ? capacity(planet,'ground') : 8} · 矿业惩罚 {detail.mining} · 全国贡献 {contribution?.contribution.toFixed(2) ?? '0'}</summary>
    <p>民生收益 +{detail.positive}；人口权重 {((contribution?.weight ?? 0) * 100).toFixed(1)}%</p>
    {Object.entries(STRUCTURES).filter(([type])=>industrial(state) || !(type in EXTRA)).map(([type, rule]) => <div key={type}>{rule.name} ×{planet.structures.filter(structure => structure.type === type).length} · 维护 电{rule.energy} / 矿{rule.upkeep}{type === 'sanatorium' ? ' · 上限1/行星' : type === 'resort' ? ' · 上限2/行星' : type === 'lrs' ? ' · 上限1/星系' : ''}</div>)}
  </details></>;
}

export function IntelLabel({ state, viewer, system }: { state: GameState; viewer: string; system: StarSystem }) {
  if (!viewer) return null;
  const local = controller(system) === viewer || state.fleets.some(fleet => fleet.ownerId === viewer && fleet.systemId === system.id);
  const lrs = sensorCoverage(state, viewer).has(system.id);
  const intel = state.factions[viewer].militaryIntel?.[system.id] ?? state.factions[viewer].intel[system.id];
  return <div className="civil-summary">该势力军事情报：{local ? '本地视野' : lrs ? 'LRS 实时' : intel ? `最后已知 · 第${intel.day}日` : '未获知'}<small>当前显示所选势力已知资料；LRS 不提供行星经济信息。</small></div>;
}

export function CivilRules({ state }: { state: GameState }) {
  if(modern(state)) return <><h3>V5：制度、待遇与政策</h3><p>普通世俗可暂不承诺；永久乌托邦、军国、国教互斥不可撤回。五档世俗待遇每360日可调，乌托邦锁最高、国教锁教廷保障；基础维护先付，福利按电矿粮共同兑现比例结算。最高福利不自动建国。乌托邦可合法参战，禁止征服准备；战争本身不使民生评估失格。</p><p>720日政策只含演习（舰队战力1.03、舰船维护1.05）、交流（有正式和平时凝聚力+.5、增长1.05）、监听（正常LRS维护.85）及不采用。无自动续期，LRS仍需满员且仅两跳。</p><p>未来经济预测冻结控制权；工业惩罚与福利分别展示。文明分上限1500，福利账单不替代基础维护。</p></>;
  return <><h3>民生、矿业与凝聚力</h3><p>疗养所+2（每行星1座），度假区每座+4（每行星2座）。每行星前两座矿场无惩罚，第三座起每座−2。按人口占比计算全国贡献。正常供应+1；食物、电力、矿物维护短缺分别−12、−4、−4，叠加且取消基础+1。正凝聚力收益受短缺倍率影响，负惩罚不减轻。</p><h3>LRS 长程侦测</h3><p>阵列占轨道槽，每星系1座，沿航道覆盖本地及两跳以内军事信息。需电力及维护供应正常，食物短缺不影响。仅两端均在覆盖区的航道可持续追踪。不揭示行星设施、人口、队列、资源或敌方政策，不代替探索。</p><h3>两年政策</h3><p>每届720日，含跳过仅能选择一次，不自动续期。开局选择首届，换届前最后一个决策回合预选下届。穷兵黩武将矿业和短缺凝聚力惩罚乘1.5。资源倍率只修正产出，维护不变。</p><table><thead><tr><th>政策</th><th>电力/矿物/食物</th><th>凝聚力</th><th>战力</th></tr></thead><tbody>{Object.entries(POLICIES).filter(([id])=>['none','militarism','utopia','balanced'].includes(id)).map(([id, policy]) => <tr key={id}><td>{policy.name}</td><td>{(balancedRules(state) && id === 'utopia' ? BALANCE.utopiaProduction[0] : policy.energy)}/{(balancedRules(state) && id === 'utopia' ? BALANCE.utopiaProduction[0] : policy.minerals)}/{policy.food}</td><td>{policy.unity}</td><td>×{policy.combat}</td></tr>)}</tbody></table><h3>审计与编年史</h3><p>每次请求、公开返回、校验、十日经济与战役都写入追加日志。未提交尝试有单独标记，不能作为历史事实。编年史使用确定性模板，可随时导出，无需额外调用模型。</p></>;
}
