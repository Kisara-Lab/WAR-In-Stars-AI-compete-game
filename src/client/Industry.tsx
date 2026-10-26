import './industry.css';
import { governed } from '../shared/governance.js';
import { constructionView } from '../shared/construction.js';
import { INDUSTRY, LABOR, EXTRA, EXPANSIONS, industrial, industryPlanet, TRAIT_NAMES, reserveScore } from '../shared/industry.js';
import { STRUCTURES } from '../shared/rules.js';
import type { GameState, Planet, StarSystem } from '../shared/types.js';
import { occupied } from '../shared/v4.js';

export function IndustrySummary({state, actor}: {state: GameState; actor: string}) {
  if (!industrial(state)) return null;
  const faction = state.factions[actor], score = reserveScore(faction.resources);
  return <div className="civil-summary industry-summary"><strong>合金 {( (faction.resources.alloys ?? 0) / 1000).toFixed(1)} · 本轮净收支 {((faction.lastIncome.alloys ?? 0)/1000).toFixed(1)}</strong><small>储备分 {score.toFixed(1)} / 400 · 矿物＋2×合金</small><progress aria-label="储备评分" value={score} max={400}/><small>前2000价值每10计1分，随后8000每40计1分；超出不计。</small><small>原料先保障维护，再按冶炼需求同比分配；缺合金不产生全国短缺。</small></div>;
}
export function IndustryPlanet({state, system, planet}: {state: GameState; system: StarSystem; planet: Planet}) {
  if (!industrial(state) || !planet.ownerId) return null;
  const detail = industryPlanet(planet, state.day);
  const lines = constructionView(state,system,planet);
  const queues = system.projects.filter(p => p.planetId === planet.id).sort((a,b) => a.createdDay-b.createdDay || a.id.localeCompare(b.id));
  return <details className="industry-planet"><summary>人口岗位与产业 · {detail.employed.toFixed(1)}/{detail.population} 就业 · {TRAIT_NAMES[detail.trait]}</summary><p>需求 {detail.jobs} 岗位；人口容量 {detail.populationCap}。{occupied(system) ? '占领期间建设及人口增长暂停。' : ''}</p><table><thead><tr><th>设施</th><th>岗位</th><th>运营／状态</th><th>维护</th></tr></thead><tbody>{detail.buildings.map(b => <tr key={b.id}><td>{b.name}</td><td>{b.assignedJobs.toFixed(1)}/{b.requiredJobs}</td><td>{b.sealed ? '封存' : b.restartDays ? `重启剩${b.restartDays}日` : `${Math.round(b.operation*100)}%${b.operation < 1 ? ' 缺员' : ''}`}</td><td>{Math.round(b.maintenance*100)}%</td></tr>)}</tbody></table><p>产业占比（已就业岗位）：{Object.entries(STRUCTURES).map(([type,rule]) => {const n=detail.buildings.filter(b=>b.type===type).reduce((s,b)=>s+b.assignedJobs,0);return n ? `${rule.name} ${Math.round(n/Math.max(1,detail.employed)*100)}%` : '';}).filter(Boolean).join(' · ') || '无就业'}。标签没有额外加成。</p><p>{governed(state)?`地表/轨道各${lines.constructionLines}条施工线；造船${lines.shipLines}条。${lines.secondShipLineReason}`:'地表、轨道各一条施工队列；造舰独立。'}</p>{governed(state)&&<details><summary>施工线与完工估算</summary>{lines.queues.flatMap(q=>q.projects.map(p=><p key={p.id}>{p.id} 线{p.line}：{p.paused??'施工中'} 预计第{p.estimatedCompleteDay??'?'}日完工</p>))}<small>{lines.assumption}</small></details>}{['ground','orbital','ship'].map(slot=><p key={slot}>{slot==='ground'?'地表':slot==='orbital'?'轨道':'造舰'}：{queues.filter(p=>slot==='ship'?p.kind==='ship':p.expansion?EXPANSIONS[p.expansion].slot===slot:p.structureType?STRUCTURES[p.structureType].slot===slot:false).map(p=>`${p.structureType?STRUCTURES[p.structureType].name:p.expansion?'扩槽':'造舰'} ${Math.floor(p.progress/1000)}/${p.requiredDays}日`).join(' → ') || '空闲'}</p>)}<p>扩建门槛：地表10槽需8人口、300矿物；12槽需12人口、600矿物；轨道8槽需10人口、400矿物＋100合金。空槽不增加劳动力。</p></details>;
}
export function IndustryRules({state}: {state:GameState}) {
  if (!industrial(state)) return null;
  return <section className="industry-rules"><h3>4.3 人口产业规则（替代旧版对应经济参数）</h3><p>每人口1岗位，地表和轨道共享。缺员按运营比例生效，维护20%＋80%×运营比例；封存维护10%，重启{INDUSTRY.restartDays}日。居住建筑无岗位、全额维护。地表8→10→12槽，轨道6→8槽。人口容量16→24，增长倍率最高2。</p><p>矿物40→合金20，受岗位及生产效率影响，不重复吃矿物政策倍率。新舰船矿物／合金：驱逐20/20、巡洋60/60、战列160/160、无畏400/400；维修同材料比例。维护仍为电力和矿物。</p><table><thead><tr><th>新增建筑</th><th>矿／合金</th><th>岗位／上限</th><th>工期</th></tr></thead><tbody>{Object.keys(EXTRA).map(key=>{const type=key as keyof typeof EXTRA;return <tr key={type}><td>{STRUCTURES[type].name}</td><td>{STRUCTURES[type].minerals}/{LABOR[type].alloys}</td><td>{LABOR[type].jobs}/{LABOR[type].limit}</td><td>{STRUCTURES[type].days}</td></tr>})}</tbody></table><p>本地精炼、农业加工、太阳能调度及干船坞各最多1座，加成25%且随运营比例缩减。医疗增长＋20%，维护站驻留舰船维护−15%。禀赋对应产出或人口增长＋15%。冶炼厂每座满负荷产生−1行星凝聚力贡献。</p></section>;
}
