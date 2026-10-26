import { governed, actionLimit } from '../shared/governance.js';
import { IndustryPlanet, IndustrySummary, IndustryRules } from './Industry.js';
import { industrial, capacity, EXTRA, LABOR, BUILDING_EFFECTS } from '../shared/industry.js';
import { ScoreDetail } from './Escalation.js';
import { revised } from '../shared/escalation.js';
import { CivilizationPanel, V4Rules } from './Civilization.js';
import { viewpoint } from '../shared/viewpoint.js';
import { controller, occupied, faithEffects } from '../shared/v4.js';
import { AuditPanel } from './Audit.js';
import { CivilRules, CivilSummary, IntelLabel, PlanetCivil } from './Civil.js';
import { currentPolicy } from '../shared/civil.js';
import './civil.css';
import { useEffect, useRef, useState } from 'react';
import { BASE, DEFAULT_CONFIG, FACTION_PRESETS, factionIds, factionRecord, RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { GameState, LiveSnapshot, MatchConfig, StarSystem } from '../shared/types.js';
import { DiplomacyPanel } from './Diplomacy.js';
import { relationLabel, relationship } from '../shared/diplomacy.js';
import { factionScores } from '../shared/scoring.js';
import { StarMap } from './Map.js';

type SaveMeta = { id: string; seed: string; round: number; firstRound: number; day: number; controller: string; updatedAt: string; result: GameState['result'] };
type ProviderInfo = { configured: boolean; models: string[]; host?: string; error?: string };
const format = (value: number, digits = 0) => value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const resource = (value: number) => format(value / 1000, value < 10000 ? 1 : 0);
const power = (state: GameState, factionId: FactionId) => state.fleets.filter(fleet => fleet.ownerId === factionId).flatMap(fleet => fleet.ships).reduce((sum, ship) => sum + ship.hull, 0) * 0.5 ** Object.values(state.factions[factionId].shortages).filter(Boolean).length * currentPolicy(state, factionId).combat * faithEffects(state.factions[factionId], state.day).combat;
const phaseName = { ready: '等待开局', deciding: 'AI 正在决策', simulating: '推进星际时间', paused: '比赛已暂停', finished: '比赛已结束', error: '需要重试' };
const eventName: Record<string, string> = { war: '战争目标', religion: '信仰', beacon: '文明灯塔', policy: '政策', diplomacy: '外交', construction: '建造', exploration: '探索', colony: '殖民', movement: '航行', battle: '交战', capture: '主权', economy: '经济', population: '人口', order: '命令', game: '比赛' };
const toolName: Record<string, string> = { prepare_conquest: '准备征服', cancel_conquest: '撤回征服', create_claim: '建立宣称', enforce_peace: '强制议和', establish_religion: '永久立教', consecrate: '祝圣', respond_dispute: '回应教义争端', integrate_thought: '思想整合', get_industry: '查询产业', set_jobs: '就业优先级', set_structure_status: '封存或重启', expand_slots: '扩建槽位', get_wars: '查询战争', get_faith: '查询信仰', choose_policy: '选择政策', confirm_contact: '确认接触', declare_war: '宣战', propose_peace: '提议停战', accept_peace: '接受停战', reject_peace: '拒绝停战', withdraw_peace: '撤回停战', open_borders: '开放边境', close_borders: '关闭边境', get_diplomacy: '查询外交', submit_turn: '提交整轮命令', survey_system: '探索星系', build_starbase: '建立基地', colonize_planet: '殖民行星', build_structure: '建设设施', scrap_structure: '拆除设施', queue_ships: '生产舰船', move_fleet: '调动舰队', split_fleet: '拆分舰队', merge_fleets: '合并舰队', cancel_order: '取消项目', get_report: '查看情报', end_turn: '结束决策' };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 ${response.status}`);
  return result as T;
}

function FactionPanel({ snapshot, factionId }: { snapshot: LiveSnapshot; factionId: FactionId }) {
  const { state, status } = snapshot;
  const faction = state.factions[factionId];
  const tally = factionScores(state);
  const rank = 1 + factionIds(state).filter(id => state.factions[id].eliminatedDay === undefined && tally[id] > tally[factionId]).length;
  const owned = state.systems.filter(system => system.ownerId === factionId);
  const planets = owned.flatMap(system => system.planets).filter(planet => planet.ownerId === factionId);
  const ships = state.fleets.filter(fleet => fleet.ownerId === factionId).flatMap(fleet => fleet.ships);
  return <section className={`faction-card ${factionId}`} style={{ '--faction': faction.color } as React.CSSProperties}>
    <div className="faction-heading"><span className="faction-emblem">{factionId === 'aurora' ? '◇' : '✧'}</span><div><small>EMPIRE {String(factionIds(state).indexOf(factionId) + 1).padStart(2, '0')}</small><h2>{faction.name}</h2></div><span className="status-dot" /></div>
    {faction.eliminatedDay !== undefined && <div className="shortage">已淘汰 · 第 {faction.eliminatedDay} 日</div>}<div className="model-tag"><span className="mini-chip">AI</span> {state.config.controller === 'scripted' ? '脚本演示' : state.config.models[factionId]}</div>
    <div className="resource-list">{([['energy', 'ϟ', '电力'], ['food', '❋', '食物'], ['minerals', '◆', '矿物']] as const).map(([key, icon, label]) => <div className="resource-row" key={key}><span className={`resource-icon ${key}`}>{icon}</span><span>{label}</span><strong>{resource(faction.resources[key])}</strong><small className={faction.lastIncome[key] >= 0 ? 'positive' : 'negative'}>{faction.lastIncome[key] >= 0 ? '+' : ''}{resource(faction.lastIncome[key])}</small></div>)}</div>
    <IndustrySummary state={state} actor={factionId} />
    <div className="unity-label"><span>凝聚力</span><strong>{(faction.unity / 100).toFixed(1)}<small> / 100</small></strong></div><div className="unity-track"><i style={{ width: `${faction.unity / 100}%` }} /></div>
    {Object.values(faction.shortages).some(Boolean) && <div className="shortage">供应短缺：{Object.entries(faction.shortages).filter(([, value]) => value).map(([key]) => ({ energy: '电力', food: '食物', minerals: '维护' })[key]).join('、')}</div>}
    <CivilSummary state={state} factionId={factionId} /><ScoreDetail state={state} actor={factionId} />
    <div className="empire-stat-grid"><div><strong>{owned.length}</strong><small>星系</small></div><div><strong>{planets.length}</strong><small>殖民地</small></div><div><strong>{planets.reduce((sum, planet) => sum + planet.population, 0)}</strong><small>人口</small></div></div>
    <div className="military-line"><span>△ 舰队战力</span><strong>{format(power(state, factionId), 1)}</strong><small>{ships.length} 艘</small></div>
    <div className="ai-state"><i className={status.phase === 'deciding' ? 'thinking' : ''} />{faction.eliminatedDay === undefined ? `第 ${rank} 名 · ${format(tally[factionId], governed(state)?3:1)} 分 · ` : '已淘汰 · '}{status.ai[factionId]?.status ?? '历史记录'}</div>
    {state.fleets.filter(fleet => fleet.ownerId === factionId && fleet.withdrawal?.emergencyUntil).map(fleet => <div className="shortage" key={fleet.id}>{fleet.name}紧急撤离：剩余 {fleet.withdrawal!.emergencyUntil! - state.day} 日</div>)}
  </section>;
}

function SystemPanel({ state, system, onEnter, viewer }: { state: GameState; system: StarSystem; onEnter: () => void; viewer: string }) {
  const [tab, setTab] = useState<'planets' | 'fleets'>('planets');
  const fleets = state.fleets.filter(fleet => fleet.systemId === system.id);
  const faction = system.ownerId ? state.factions[system.ownerId] : null;
  return <aside className="system-panel">
    <div className="section-label">SELECTED SYSTEM <span>{system.id.toUpperCase()}</span></div>
    <div className="system-title"><span className="stellar-symbol">✦</span><h2>{system.name}</h2><button title="进入星系" onClick={onEnter}>↗</button></div>
    <div className="sovereignty" style={{ color: faction?.color ?? '#8e9bb2' }}><i style={{ background: faction?.color ?? '#8e9bb2' }} />{faction?.name ?? '无主星系'}</div>
    {state.version >= 4 && <div className="civil-summary">法理：{faction?.name ?? '无主'} · 军事控制：{controller(system) ? state.factions[controller(system)!].name : '无'}{occupied(system) ? ' · 临时占领，原有项目暂停' : ''}{(system.base?.disabledUntil ?? 0) > state.day ? ` · 基地停用剩余${system.base!.disabledUntil! - state.day}日` : ''}</div>}
    <IntelLabel state={state} viewer={viewer} system={system} />
    <div className="base-card"><span>⌘ 恒星基地</span><strong>{system.base ? `${format(system.base.hull, 1)} / ${BASE.power}` : '未建立'}</strong>{system.base && <div className="hull-track"><i style={{ width: `${system.base.hull / BASE.power * 100}%`, background: faction?.color }} /></div>}</div>
    <div className="small-tabs"><button className={tab === 'planets' ? 'active' : ''} onClick={() => setTab('planets')}>行星 <span>{system.planets.length}</span></button><button className={tab === 'fleets' ? 'active' : ''} onClick={() => setTab('fleets')}>舰队 <span>{fleets.length}</span></button></div>
    <div className="system-scroll">{tab === 'planets' ? system.planets.map((planet, index) => {
      const ground = planet.structures.filter(structure => STRUCTURES[structure.type].slot === 'ground');
      const orbital = planet.structures.filter(structure => STRUCTURES[structure.type].slot === 'orbital');
      const projects = system.projects.filter(project => project.planetId === planet.id);
      return <div className="planet-card" key={planet.id}>
        <div className="planet-heading"><div className={`planet-art planet-${index % 3}`} /><div><strong>{planet.name}</strong><small>{planet.population ? `${planet.population} 人口 · ${planet.ownerId ? state.factions[planet.ownerId].name : '失去主权'}` : '未殖民'}</small></div></div>
        <div className="slot-label"><span>地表设施</span><small>{ground.length} / {industrial(state) ? capacity(planet, 'ground') : RULES.groundSlots}</small></div><div className="slots">{Array.from({ length: industrial(state) ? capacity(planet, 'ground') : RULES.groundSlots }, (_, slot) => <span title={ground[slot] ? STRUCTURES[ground[slot].type].name : '空槽位'} className={ground[slot] ? 'filled' : ''} key={slot}>{ground[slot] ? ground[slot].type === 'mine' ? '◆' : '❋' : '·'}</span>)}</div>
        <div className="slot-label"><span>轨道设施</span><small>{orbital.length} / {industrial(state) ? capacity(planet, 'orbital') : RULES.orbitalSlots}</small></div><div className="slots orbital">{Array.from({ length: industrial(state) ? capacity(planet, 'orbital') : RULES.orbitalSlots }, (_, slot) => <span title={orbital[slot] ? STRUCTURES[orbital[slot].type].name : '空槽位'} className={orbital[slot] ? 'filled' : ''} key={slot}>{orbital[slot] ? orbital[slot].type === 'solar' ? 'ϟ' : '⌘' : '·'}</span>)}</div>
        <PlanetCivil state={state} planet={planet} />
        {(!viewer || planet.ownerId === viewer) && <IndustryPlanet state={state} system={system} planet={planet} />}
        {projects.slice(0, 4).map(project => <div className="project" key={project.id}><span>{project.kind === 'expansion' ? '扩建槽位' : project.kind === 'consecrate' ? '祝圣' : project.kind === 'colonize' ? '殖民' : project.shipType ? SHIPS[project.shipType].name : project.structureType ? STRUCTURES[project.structureType].name : '建设'}</span><small>{Math.min(100, Math.floor(project.progress / 1000 / project.requiredDays * 100))}%</small><i style={{ width: `${Math.min(100, project.progress / 1000 / project.requiredDays * 100)}%` }} /></div>)}{projects.length > 4 && <small className="muted">另有 {projects.length - 4} 个排队项目</small>}
      </div>;
    }) : fleets.length ? fleets.map(fleet => <div className="fleet-card" key={fleet.id}><div className="fleet-title" style={{ color: state.factions[fleet.ownerId].color }}>△ {fleet.name}</div><small>{viewer ? fleet.ownerId === viewer ? '己方' : relationLabel(relationship(state, viewer, fleet.ownerId), state.day) : state.factions[fleet.ownerId].name}{fleet.withdrawal ? ` · ${fleet.withdrawal.emergencyUntil ? '紧急撤离中' : '强制撤离中'}` : ''}</small><div className="fleet-numbers"><span>{fleet.ships.length} 艘</span><strong>战力 {format(fleet.ships.reduce((sum, ship) => sum + ship.hull, 0), 1)}</strong></div><small>{Object.entries(SHIPS).map(([type, rule]) => { const count = fleet.ships.filter(ship => ship.type === type).length; return count ? `${rule.name}×${count}` : ''; }).filter(Boolean).join(' · ')}</small><p>{fleet.order ? `前往 ${state.systems.find(candidate => candidate.id === fleet.order!.systemId)?.name}` : '原地待命'}<span>({Math.round(fleet.position.x)}, {Math.round(fleet.position.y)})</span></p></div>) : <div className="empty-state">当前星系没有舰队</div>}
    {system.projects.filter(project => project.kind === 'base' || project.kind === 'survey').map(project => <div className="planet-card" key={project.id}><div className="project"><span>{project.kind === 'base' ? '建立恒星基地' : '探索星系'} · {state.factions[project.ownerId].name}</span><small>{Math.floor(project.progress / 1000 / project.requiredDays * 100)}%</small><i style={{ width: `${project.progress / 1000 / project.requiredDays * 100}%` }} /></div></div>)}</div>
    <div className="system-footer">超空间航道 <strong>{system.neighbors.length}</strong><span>法理归属与军事控制分别记录</span></div>
  </aside>;
}

export function App() {
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [replay, setReplay] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState('s0');
  const [viewer, setViewer] = useState('');
  const [eventFilter, setEventFilter] = useState('all');
  const [mode, setMode] = useState<'galaxy' | 'system'>('galaxy');
  const [bottomTab, setBottomTab] = useState<'events' | 'decisions' | 'workers' | 'diplomacy' | 'audit'>('events');
  const [modal, setModal] = useState<'settings' | 'saves' | 'rules' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [provider, setProvider] = useState<ProviderInfo>({ configured: false, models: ['grok-4.7'] });
  const [form, setForm] = useState<MatchConfig & { workers: number }>({ ...structuredClone(DEFAULT_CONFIG), workers: 8 });
  const [workerLimit, setWorkerLimit] = useState(30);
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [archive, setArchive] = useState('');
  const [replayRound, setReplayRound] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  useEffect(() => { setViewer(''); }, [live?.state.id, replay?.state.id]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onmessage = event => { try { setLive(JSON.parse(event.data) as LiveSnapshot); } catch { setError('状态更新格式无效'); } };
      socket.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 1500); };
      socket.onerror = () => socket.close();
    };
    connect();
    void api<LiveSnapshot>('/state').then(snapshot => { if (!closed) { setLive(snapshot); setForm({ ...(snapshot.state.config.factionIds?.length >= 4 ? snapshot.state.config : structuredClone(DEFAULT_CONFIG)), workers: Math.max(1, snapshot.status.workers.length) }); } }).catch(error => setError(error.message));
    void api<ProviderInfo>('/provider').then(setProvider).catch(() => {});
    void api<{ maxWorkers: number }>('/health').then(result => setWorkerLimit(result.maxWorkers)).catch(() => {});
    return () => { closed = true; clearTimeout(retry); socketRef.current?.close(); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);

  async function perform(action: () => Promise<void>) {
    setError(''); setPending(true);
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setPending(false); }
  }
  const command = (path: string) => perform(async () => { await api(path, {}); });
  async function openSaves() {
    setModal('saves');
    await perform(async () => { const entries = await api<SaveMeta[]>('/matches'); setSaves(entries); const entry = entries.find(entry => entry.id === live?.state.id) ?? entries[0]; if (entry) { setArchive(entry.id); setReplayRound(entry.round); } });
  }
  async function showReplay(id: string, round: number) {
    await perform(async () => {
      const checkpoint = await api<{ state: GameState; lastDecisions: LiveSnapshot['lastDecisions']; metrics: LiveSnapshot['status']['metrics'] }>(`/matches/${id}/rounds/${round}`);
      if (!live) return;
      setReplay({ state: checkpoint.state, lastDecisions: checkpoint.lastDecisions, status: { ...live.status, phase: checkpoint.state.result ? 'finished' : 'paused', busy: false, running: false, metrics: checkpoint.metrics } });
      setModal(null); setReplayRound(round);
    });
  }

  const snapshot = replay ?? live;
  if (!snapshot) return <div className="loading"><div className="loading-orbit" /><h1>WAR IN STARS</h1><p>{error || '正在连接星际战场…'}</p></div>;
  const { state: sourceState, status } = snapshot;
  const activeViewer = factionIds(sourceState).includes(viewer) ? viewer : '';
  const state = viewpoint(sourceState, activeViewer);
  const system = state.systems.find(candidate => candidate.id === selected) ?? state.systems[0];
  const locked = pending || !!replay || status.busy || status.running;
  const archiveMeta = saves.find(save => save.id === archive);
  const scores = state.result?.scores;
  const ids = factionIds(state);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">✦</div><div><h1>WAR IN STARS<span>AI COMPETE</span></h1><small>星际策略 · 多方 AI 外交观察台</small></div></div>
      <div className="match-clock"><span className={`live-indicator ${status.busy ? 'active' : ''}`} />{replay ? '历史复盘' : phaseName[status.phase]}<div><strong>{String(state.round).padStart(3, '0')}</strong><span> / {state.config.maxRounds} 轮</span><i /><small>第 {format(state.day)} 日</small></div></div>
      <div className="header-actions"><button className="quiet" onClick={() => setModal('rules')}>规则</button><button className="quiet" onClick={() => void openSaves()}>存档 / 复盘</button><button className="outline" disabled={locked} onClick={() => { setForm({ ...(live!.state.config.factionIds?.length >= 4 ? live!.state.config : structuredClone(DEFAULT_CONFIG)), workers: Math.max(1, live!.status.workers.length) }); setModal('settings'); }}>＋ 新比赛</button></div>
    </header>
    <div className="control-bar"><div className="breadcrumb"><span>⌘ 观察者</span><b>/</b><button className={mode === 'galaxy' ? 'selected' : ''} onClick={() => setMode('galaxy')}>星系群</button>{mode === 'system' && <><b>/</b><span className="selected">{system.name}</span></>}</div><div className="controls">{replay ? <button className="primary" onClick={() => setReplay(null)}>↩ 返回实时比赛</button> : <><button className="primary" disabled={pending || status.busy || status.running || !!state.result} onClick={() => void command('/start')}>▶ {status.phase === 'error' ? '重试本轮' : state.round ? '继续比赛' : '开始比赛'}</button><button disabled={pending || !status.busy && !status.running} onClick={() => void command('/pause')}>Ⅱ 暂停</button><button disabled={locked || !!state.result} onClick={() => void command('/step')}>▷ 单轮推进</button><span className="control-divider" /><button disabled={pending || status.busy} onClick={() => void perform(async () => { await api('/save', {}); setNotice('已保存当前轮，比赛也会每轮自动存档。'); })}>↓ 保存</button></>}<span className="control-mode">{state.config.controller === 'scripted' ? '脚本演示' : 'AI vs AI'}</span></div></div>
    {(error || (!replay && status.error)) && <div className="error-banner"><span>⚠ {error || status.error}</span><button onClick={() => setError('')}>×</button></div>}
    {notice && <div className="toast">✓ {notice}</div>}
    {state.result && <div className="result-banner"><span>✧</span><strong>{state.result.winner ? `${state.factions[state.result.winner].name} 获胜` : '比赛平局'}</strong><small>{state.result.reason === 'elimination' ? '其他势力均已淘汰' : '达到轮数上限，按综合评分结算'}</small><span className="result-score">{ids.slice().sort((first, second) => scores![second] - scores![first]).map((id, index) => <span key={id} style={{ color: state.factions[id].color }}>{index + 1}. {state.factions[id].name} {format(scores![id], 1)} </span>)}</span></div>}
    {replay && <div className="replay-bar"><span>↶ 正在查看历史第 {state.round} 轮</span><button disabled={pending || state.round <= (archiveMeta?.firstRound ?? 0)} onClick={() => void showReplay(archive || state.id, state.round - 1)}>上一轮</button><button disabled={pending || state.round >= (archiveMeta?.round ?? state.round)} onClick={() => void showReplay(archive || state.id, state.round + 1)}>下一轮</button><button disabled={pending || live!.status.busy || live!.status.running || !!state.result} onClick={() => void perform(async () => { setLive(await api<LiveSnapshot>('/load', { id: state.id, round: state.round })); setReplay(null); setNotice('已从历史状态创建新比赛分支。'); })}>从这里继续</button>{state.rulesRevision !== '5.4' && <button disabled={pending || live!.status.busy || live!.status.running || !!state.result} onClick={() => void perform(async () => { setLive(await api<LiveSnapshot>('/load', { id: state.id, round: state.round, rulesRevision: '5.4' })); setReplay(null); setNotice('已从此回合创建暂停的V5.4分支，原档不变。'); })}>以V5.4创建分支</button>}</div>}
    {state.result && <details className="result-breakdown civil-summary"><summary>结果榜 · 评分分解</summary>{ids.filter(id => !activeViewer || id === activeViewer).map(id => <ScoreDetail key={id} state={state} actor={id} />)}</details>}
    <main className="battle-layout"><aside className="empires-panel"><div className="section-label">COMPETING EMPIRES<span>{ids.length}</span></div>{ids.filter(id => !activeViewer || id === activeViewer).map(id => <FactionPanel key={id} snapshot={{ ...snapshot, state }} factionId={id} />)}<div className="income-note">资源右侧为上一轮净收支 · 每轮 100 日</div></aside>
      <section className="map-panel"><div className="map-toolbar"><div className="view-switch"><button className={mode === 'galaxy' ? 'active' : ''} onClick={() => setMode('galaxy')}>◉ 星系群</button><button className={mode === 'system' ? 'active' : ''} onClick={() => setMode('system')}>◎ 单星系</button></div><select aria-label="观察势力" value={activeViewer} onChange={event => setViewer(event.target.value)}><option value="">全图观察</option>{ids.map(id => <option key={id} value={id}>{state.factions[id].name}</option>)}</select><select aria-label="选择星系" value={system.id} onChange={event => setSelected(event.target.value)}>{state.systems.map(system => <option key={system.id} value={system.id}>{system.name}{system.ownerId ? ` · ${state.factions[system.ownerId].name}` : ''}</option>)}</select></div><StarMap state={state} viewer={activeViewer} selected={system.id} mode={mode} onSelect={setSelected} onEnter={() => setMode('system')} /></section>
      <SystemPanel viewer={activeViewer} state={state} system={system} onEnter={() => setMode('system')} />
    </main>
    <CivilizationPanel state={state} />
    <section className={`timeline-panel ${bottomTab === 'audit' ? 'audit-expanded' : bottomTab === 'diplomacy' ? 'expanded' : ''}`}><div className="timeline-header"><div className="bottom-tabs"><button className={bottomTab === 'audit' ? 'active' : ''} onClick={() => setBottomTab('audit')}>完整审计日志</button><button className={bottomTab === 'diplomacy' ? 'active' : ''} onClick={() => setBottomTab('diplomacy')}>外交关系</button><button className={bottomTab === 'events' ? 'active' : ''} onClick={() => setBottomTab('events')}>事件时间线 <span>{state.events.filter(event => event.type !== 'order').length}</span></button><button className={bottomTab === 'decisions' ? 'active' : ''} onClick={() => setBottomTab('decisions')}>AI 决策记录</button><button className={bottomTab === 'workers' ? 'active' : ''} onClick={() => setBottomTab('workers')}>模拟性能</button></div>{bottomTab === 'events' && <select aria-label="筛选事件" value={eventFilter} onChange={event => setEventFilter(event.target.value)}><option value="all">全部事件</option><option value="diplomacy">外交事件</option><option value="battle">战斗事件</option><option value="war">战争目标</option><option value="religion">信仰事件</option><option value="beacon">文明灯塔</option>{ids.map(id => <option key={id} value={id}>{state.factions[id].name}</option>)}</select>}<span className="timeline-label">{bottomTab === 'diplomacy' ? '双边关系 · 通行权有方向' : bottomTab === 'events' ? '最新事件在前' : bottomTab === 'decisions' ? '公开战略摘要与工具命令' : '真实星系计算任务'}</span></div>
      <div className="timeline-content">{bottomTab === 'audit' ? <AuditPanel key={state.id} state={state} /> : bottomTab === 'diplomacy' ? <DiplomacyPanel state={state} /> : bottomTab === 'events' ? state.events.filter(event => event.type !== 'order' && (eventFilter === 'all' || event.type === eventFilter || event.audience.includes(eventFilter))).slice(-100).reverse().map(event => <button className={`event-row ${event.type}`} key={event.id} onClick={() => { if (event.systemId) setSelected(event.systemId); }}><span className="event-day">DAY {String(event.day).padStart(5, '0')}</span><span className="event-badge">{eventName[event.type]}</span><span>{event.text}</span>{event.systemId && <small>↗</small>}</button>) : bottomTab === 'decisions' ? <div className="decisions-grid">{ids.filter(id => !activeViewer || id === activeViewer).map(factionId => <div className="decision-column" key={factionId}><div className="decision-heading" style={{ color: state.factions[factionId].color }}>{state.factions[factionId].name}<small>{snapshot.lastDecisions?.[factionId]?.metrics.requests ?? 0} 次请求 · {format(snapshot.lastDecisions?.[factionId]?.metrics.totalTokens ?? 0)} tokens{snapshot.lastDecisions?.[factionId]?.metrics.unknownUsageRequests ? ' · 部分请求用量未知' : ''}</small></div><small>AI 公开计划；是否执行以事件及结算记录为准。</small><p>{snapshot.lastDecisions?.[factionId]?.summary ?? '比赛开始后，在这里查看 AI 的战略与命令。'}</p>{snapshot.lastDecisions?.[factionId]?.trace.map((trace, index) => <details className={`tool-trace ${trace.ok && trace.disposition !== 'rolled_back' ? '' : 'failed'}`} key={index}><summary>{trace.ok && trace.disposition !== 'rolled_back' ? '✓' : '×'} {toolName[trace.name] ?? trace.name}<small>{trace.disposition === 'rolled_back' ? '整批已回滚' : trace.disposition === 'accepted' ? '校验接受，非执行证明' : trace.ok ? '已接受' : '已拒绝'}</small></summary><pre>{trace.batchId && `批次：${trace.batchId}\n`}{JSON.stringify(trace.args, null, 2)}{`\n${trace.message}`}</pre></details>)}</div>)}</div> : <div className="worker-grid">{status.workers.map(worker => <div className="worker-card" key={worker.id}><span><i />WORKER {String(worker.id + 1).padStart(2, '0')}</span><strong>{format(worker.tasks)} <small>任务</small></strong><small>{format(worker.systems)} 星系阶段 · {format(worker.durationMs, 1)} ms</small></div>)}</div>}{bottomTab === 'events' && !state.events.length && <div className="empty-events"><span>✧</span><div>星海静候第一道命令<small>点击「开始比赛」，观察各方 AI 如何书写各自的文明。</small></div></div>}</div>
    </section>
    <footer className="statusbar"><span><i className={connected ? 'online-dot' : 'offline-dot'} />{connected ? '战场已连接' : '正在重新连接'}</span><span>{status.workers.length} 个模拟线程</span><span>种子 {state.config.seed}</span><span className="footer-right">本局 {format(ids.reduce((sum, factionId) => sum + (status.metrics[factionId]?.totalTokens ?? 0), 0))} tokens<span>WAR IN STARS / 0.4</span></span></footer>
    {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}><section className={`modal ${modal === 'rules' ? 'rules-modal' : ''}`} role="dialog" aria-modal="true" aria-label={modal === 'settings' ? '新比赛设置' : modal === 'saves' ? '存档和复盘' : '游戏规则'}><div className="modal-heading"><div><small>MISSION CONTROL</small><h2>{modal === 'settings' ? '开启一场星际对决' : modal === 'saves' ? '存档与历史复盘' : '星际战场规则'}</h2></div><button aria-label="关闭" onClick={() => setModal(null)}>×</button></div>
      {modal === 'settings' ? <form onSubmit={event => { event.preventDefault(); void perform(async () => { setLive(await api<LiveSnapshot>('/matches', form)); setReplay(null); setSelected('s0'); setModal(null); }); }}><label>控制方式<select value={form.controller} onChange={event => setForm({ ...form, controller: event.target.value as MatchConfig['controller'] })}><option value="model">AI 模型对战</option><option value="scripted">脚本演示（不调用模型）</option></select></label><label>AI 势力数量<select value={form.factionIds.length} onChange={event => { const count = Number(event.target.value); const selectedIds = FACTION_PRESETS.slice(0, count).map(faction => faction.id); setForm({ ...form, factionIds: selectedIds, models: factionRecord(selectedIds, id => form.models[id] ?? 'grok-4.7'), systemCount: Math.min(Math.floor(512 / count) * count, Math.max(count * 6, Math.ceil(form.systemCount / count) * count)) }); }}>{[4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count} 方</option>)}</select></label><div className="form-row">{form.factionIds.map(factionId => <label key={factionId}>{FACTION_PRESETS.find(preset => preset.id === factionId)?.name}<select disabled={form.controller === 'scripted'} value={form.models[factionId]} onChange={event => setForm({ ...form, models: { ...form.models, [factionId]: event.target.value } })}>{[...new Set([...provider.models, form.models[factionId]])].map(model => <option key={model}>{model}</option>)}</select></label>)}</div><div className="form-row"><label>星系数量<input type="number" min={form.factionIds.length * 6} max="512" step={form.factionIds.length} value={form.systemCount} onChange={event => setForm({ ...form, systemCount: Number(event.target.value) })} /></label><label>最大轮数<input type="number" min="1" max="1000" value={form.maxRounds} onChange={event => setForm({ ...form, maxRounds: Number(event.target.value) })} /></label></div><div className="form-row"><label>地图种子<input required maxLength={100} value={form.seed} onChange={event => setForm({ ...form, seed: event.target.value })} /></label><label>模拟线程<input type="number" min="1" max={workerLimit} value={form.workers} onChange={event => setForm({ ...form, workers: Number(event.target.value) })} /></label></div><div className={`provider-state ${provider.configured ? '' : 'unavailable'}`}><i />{provider.configured ? `模型接口已配置 · ${provider.host}` : '尚未配置模型接口，可运行脚本演示'}<small>{form.controller === 'model' ? '真实模型对战会使用接口额度。每方每轮最多 3 次请求，可随时暂停。' : '脚本演示运行同一套规则，可以查看整局战争与复盘。'}</small></div><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>取消</button><button className="primary" disabled={pending || form.controller === 'model' && !provider.configured}>创建比赛</button></div></form>
      : modal === 'saves' ? <div className="saves-content"><label>选择比赛<select value={archive} onChange={event => { setArchive(event.target.value); const entry = saves.find(save => save.id === event.target.value); if (entry) setReplayRound(entry.round); }}>{saves.map(save => <option value={save.id} key={save.id}>{save.seed} · 第{save.round}轮 · {save.controller === 'scripted' ? '脚本' : 'AI'} · {new Date(save.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</option>)}</select></label>{archiveMeta && <><div className="save-summary"><strong>{archiveMeta.result ? '比赛已结束' : '可继续比赛'}</strong><span>第 {archiveMeta.day} 日 · {archiveMeta.round} 轮</span><small>{archiveMeta.id}</small></div><label>复盘轮次 <strong>{replayRound}</strong><input type="range" min={archiveMeta.firstRound} max={archiveMeta.round} value={replayRound} onChange={event => setReplayRound(Number(event.target.value))} /></label><p className="muted">复盘直接读取历史记录。继续历史状态会创建新比赛分支，原比赛记录保留。</p><div className="modal-actions"><button disabled={pending || live!.status.busy || live!.status.running} onClick={() => void perform(async () => { setLive(await api<LiveSnapshot>('/load', { id: archive })); setReplay(null); setModal(null); })}>恢复最新存档（保留修订）</button><button disabled={pending || live!.status.busy || live!.status.running} onClick={() => void perform(async () => { setLive(await api<LiveSnapshot>('/load', { id: archive, rulesRevision: '5.4' })); setReplay(null); setModal(null); setNotice('已显式创建V5.4分支，原档不变，新分支保持暂停。'); })}>以V5.4创建分支</button><button className="primary" disabled={pending} onClick={() => void showReplay(archive, replayRound)}>查看历史</button></div></>}</div>
      : <div className="rules-content"><p>4～8 个文明在同一时刻规划，随后统一推进 100 日。内部每 10 日结算，先行动与完工，再战斗、经济、人口与胜负。</p><p>每回合最多{actionLimit(state)}条实际动作，结束回合额度独立保留；批量子项逐条计数。</p><h3>网状星图与外交</h3><p>星系与航道形成旋转对称的空间网络；默认最近对手母星相距3～4跳。每对势力独立接触，双方确认后和平；接触期交火直接转战争，正式联系后必须先宣战。</p><p>协商停战需要提议与接受，非总体战归还占领地、总体战保留正式吞并，均签1080日（三年）互不侵犯，期满仍和平。提议300日过期。边境默认关闭，领土方可单向授权通行；撤销通行或停战时自动撤离，300日未撤出则执行100日紧急撤离。</p><h3>扩张与经济</h3><p>探索消耗 50 矿物，殖民消耗 200 矿物与 100 食物，均需 500 日。每方最多同时探索两个星系。基地赋予整个星系主权；每行星拥有 8 个地表、6 个轨道槽位。</p><p>凝聚力修正生产和建造效率。电力、食物、矿物维护每短缺一种，效率和战力各乘 0.5；多个短缺相乘。每个人口每轮消耗 2 食物，供应正常时每 500 日增长 1，上限 16。</p><table><thead><tr><th>设施</th><th>矿物</th><th>基础日数</th><th>每轮产出</th></tr></thead><tbody>{Object.entries(STRUCTURES).filter(([type])=>industrial(state) || !(type in EXTRA)).map(([type, rule]) => <tr key={type}><td>{rule.name}</td><td>{rule.minerals}{industrial(state) ? ` / ${LABOR[type as keyof typeof STRUCTURES].alloys} 合金` : ''}</td><td>{rule.days}</td><td>{type in EXTRA ? BUILDING_EFFECTS[type as keyof typeof STRUCTURES] : rule.output.energy ? `电力 ${rule.output.energy}` : rule.output.food ? `食物 ${rule.output.food}` : rule.output.minerals ? `矿物 ${rule.output.minerals}` : type === 'sanatorium' ? '凝聚力 +2' : type === 'resort' ? '凝聚力 +4' : type === 'lrs' ? '两跳军事侦测' : governed(state)?'正常满员干船坞可开第2线':'串行造舰'}</td></tr>)}</tbody></table><IndustryRules state={state} /><CivilRules state={state} /><V4Rules revision={state.rulesRevision} /><h3>舰队与战争</h3><table><thead><tr><th>舰型</th><th>矿物</th><th>战力</th><th>基础日数</th><th>速度</th></tr></thead><tbody>{Object.entries(SHIPS).map(([type, rule]) => <tr key={type}><td>{rule.name}</td><td>{industrial(state) ? `${rule.minerals/3} / ${rule.minerals/3}合金` : rule.minerals}</td><td>{rule.power}</td><td>{rule.days}</td><td>{rule.speed}</td></tr>)}</tbody></table><p>舰队按最慢舰船的速度移动，每条超空间航道耗时 30 日。仅战争或接触期双方距离 80 内自动交战，基地战力 40。有效战力较高者必胜，败方全毁，胜方承受败方 50% 等效伤害；相等则双方全毁。船体比例影响战力。多方同场按种子确定的敌对势力对顺序逐对交战，中立方不合兵。</p><p>V4临时占领保留法理归属和原主项目，正式割让或总体战吞并才移交行星并取消项目。己方基地附近可消耗矿物维修。取消未完成项目返还 50%，拆除建筑返还 25%。</p><h3>胜利与情报</h3><p>V4失去全部法理领土才淘汰，有限战争临时占领不能灭国，仅剩一方时结束。轮数耗尽后在存活势力中按「100 × 星系 + {governed(state)?'Q × (200 × 殖民地 + 5 × 人口)':'200 × 殖民地 + 5 × 人口'} + {revised(state) ? (industrial(state) ? '0.5 × 基础舰队战力 + 储备分（最多400） + 战争成果' : '0.5 × 基础舰队战力 + 矿物 / 10 + 战争成果') + ((state.rulesRevision === '4.2' || industrial(state)) ? ' + 文明成果（最多1500）' : '') : '基础舰队战力 + 矿物 / 10'}」评分，同分平局。观察者可以看到全图；AI 只知道本方情报和带时间戳的历史观察。</p></div>}
    </section></div>}
  </div>;
}
