import { V54, emergencyRules } from '../shared/emergency.js';
import { governed, governanceView, V53 } from '../shared/governance.js';
import { RESPONSIBILITY, responsible } from '../shared/responsibility.js';
import { INDUSTRY, industrial, BUILDING_EFFECTS, LABOR, EXPANSIONS } from '../shared/industry.js';
import { BALANCE, balancedRules } from '../shared/balance.js';
import { CIVILIZATION, DECISION_BALANCE, welfareRules, V5_POLICIES, modern } from '../shared/civilization.js';
import { AuditJournal, readJournal, sanitize } from './audit.js';
import type { AuditInput, AuditRecord } from './audit.js';
import { ESCALATION, revised } from '../shared/escalation.js';
import { scoreBreakdown } from '../shared/scoring.js';
import { BASE, RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import { POLICIES } from '../shared/civil.js';
import { V4, WAR_NAMES } from '../shared/v4.js';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Decision, DecisionMetrics, GameState, TurnRecord } from '../shared/types.js';
import type { FactionId } from '../shared/rules.js';
import { stateHash } from '../sim/math.js';

function battleSummary(details: unknown, factions: GameState['factions']): string[] {
  const battle = details as { participants?: { id: string; ownerId: string; ships: { id: string; type: keyof typeof SHIPS; hull: number }[]; baseHull?: number }[]; remaining?: { id: string; ships: { id: string; hull: number }[]; baseHull?: number }[]; effectivePower?: Record<string, number>; order?: number };
  if (!battle.participants || !battle.remaining) return ['  - 战损明细在此历史记录中缺失。'];
  const lines = [`  - 本星系当步第 ${battle.order ?? '?'} 场交战。`];
  for (const ownerId of [...new Set(battle.participants.map(unit => unit.ownerId))].sort()) {
    const participants = battle.participants.filter(unit => unit.ownerId === ownerId);
    const originalShips = participants.flatMap(unit => unit.ships);
    const remaining = battle.remaining.filter(unit => participants.some(before => before.id === unit.id));
    const survivors = remaining.flatMap(unit => unit.ships);
    const lost = originalShips.filter(ship => !survivors.some(survivor => survivor.id === ship.id));
    const types = Object.entries(SHIPS).map(([type, rule]) => ({ name: rule.name, count: lost.filter(ship => ship.type === type).length })).filter(type => type.count);
    const hullLost = originalShips.reduce((total, ship) => total + ship.hull, 0) - survivors.reduce((total, ship) => total + ship.hull, 0);
    const baseBefore = participants.reduce((total, unit) => total + (unit.baseHull ?? 0), 0);
    const baseAfter = remaining.reduce((total, unit) => total + (unit.baseHull ?? 0), 0);
    lines.push(`  - ${factions[ownerId]?.name ?? ownerId}：有效战力 ${battle.effectivePower?.[ownerId]?.toFixed(2) ?? '未记录'}；参战 ${originalShips.length} 艘，幸存 ${survivors.length} 艘；损毁 ${types.map(type => `${type.name} ${type.count} 艘`).join('、') || '无'}；舰船船体损失 ${hullLost.toFixed(3)}${baseBefore ? `；基地船体 ${baseBefore.toFixed(3)} → ${baseAfter.toFixed(3)}` : ''}。`);
  }
  return lines;
}

export interface Checkpoint {
  version: 1 | 2 | 3 | 4 | 5;
  state: GameState;
  lastDecisions: Record<FactionId, Decision> | null;
  metrics: Record<FactionId, DecisionMetrics>;
}
export interface MatchMeta {
  id: string;
  seed: string;
  round: number;
  firstRound: number;
  day: number;
  controller: string;
  models: Record<FactionId, string>;
  updatedAt: string;
  result: GameState['result'];
}

export class MatchStore {
  readonly root: string;
  private journals = new Map<string, AuditJournal>();
  private journal(id: string) {
    if (!this.journals.has(id)) this.journals.set(id, new AuditJournal(join(this.directory(id), 'audit.jsonl')));
    return this.journals.get(id)!;
  }
  async resumeAudit(id: string) {
    try { await this.journals.get(id)?.flush(); }
    catch { await readJournal(join(this.directory(id), 'audit.jsonl')); this.journals.set(id, new AuditJournal(join(this.directory(id), 'audit.jsonl'))); }
  }
  async audit(id: string, input: AuditInput) { return this.journal(id).append(input); }
  async auditMany(id: string, inputs: AuditInput[]) { return this.journal(id).appendMany(inputs); }
  async auditRecords(id: string) { return this.journals.has(id) ? this.journals.get(id)!.read() : readJournal(join(this.directory(id), 'audit.jsonl')); }
  constructor(root = '.data/matches', readonly sessionFile?: string) { this.root = resolve(root); }

  async sessionCheckpoint() {
    if (!this.sessionFile) return null;
    let pointer: { id: string };
    try { pointer = JSON.parse(await readFile(this.sessionFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return this.load(pointer.id);
  }

  private directory(id: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('存档ID无效');
    return join(this.root, id);
  }

  private async write(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'w');
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  }

  async initialize(checkpoint: Checkpoint) {
    const directory = this.directory(checkpoint.state.id);
    await mkdir(directory, { recursive: true });
    await this.write(join(directory, 'initial.json'), { ...checkpoint, hash: stateHash(checkpoint.state) });
    await this.audit(checkpoint.state.id, { category: 'match.initial', round: checkpoint.state.round, day: checkpoint.state.day, data: { rulesVersion: checkpoint.state.version, ...(modern(checkpoint.state) ? { civilization: {...CIVILIZATION, revision:checkpoint.state.rulesRevision}, welfare: welfareRules(checkpoint.state), policiesV5: V5_POLICIES } : {}), ...(industrial(checkpoint.state) ? { industry: INDUSTRY, effects: BUILDING_EFFECTS, labor: LABOR, expansions: EXPANSIONS } : {}), ...(balancedRules(checkpoint.state) ? { balance: BALANCE } : {}), ...(revised(checkpoint.state) ? { rulesRevision: checkpoint.state.rulesRevision, escalation: ESCALATION } : {}), resourceScale: 1000, unityScale: 100, rules: RULES, v4: V4, structures: STRUCTURES, ships: SHIPS, base: BASE, policies: POLICIES, state: checkpoint.state, hash: stateHash(checkpoint.state), lineage: checkpoint.state.lineage } });
    if(governed(checkpoint.state)) await this.audit(checkpoint.state.id,{category:'match.rules',round:checkpoint.state.round,day:checkpoint.state.day,data:{governance:V53,...(emergencyRules(checkpoint.state)?{emergency:V54}:{})}});
    if(responsible(checkpoint.state)) await this.audit(checkpoint.state.id,{category:'match.rules',round:checkpoint.state.round,day:checkpoint.state.day,data:{responsibilities:RESPONSIBILITY}});
    if(checkpoint.state.rulesRevision==='5.1') await this.audit(checkpoint.state.id,{category:'match.rules',round:checkpoint.state.round,day:checkpoint.state.day,data:{decisionBalance:DECISION_BALANCE}});
    await this.save(checkpoint, checkpoint.state.round);
  }

  async save(checkpoint: Checkpoint, firstRound?: number) {
    const directory = this.directory(checkpoint.state.id);
    await mkdir(directory, { recursive: true });
    const state = checkpoint.state;
    let initialRound = firstRound;
    if (initialRound === undefined) {
      try { initialRound = (JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as MatchMeta).firstRound; }
      catch { initialRound = state.round; }
    }
    await this.write(join(directory, 'checkpoint.json'), { ...checkpoint, hash: stateHash(state) });
    const meta: MatchMeta = { id: state.id, seed: state.config.seed, round: state.round, firstRound: initialRound, day: state.day, controller: state.config.controller, models: state.config.models, updatedAt: new Date().toISOString(), result: state.result };
    await this.write(join(directory, 'meta.json'), meta);
    if (this.sessionFile) await this.write(this.sessionFile, { id: state.id });
  }

  async commit(record: TurnRecord, checkpoint: Checkpoint, onCommitted: () => void = () => {}) {
    const directory = this.directory(record.state.id);
    await mkdir(directory, { recursive: true });
    await this.write(join(directory, `round-${String(record.round).padStart(4, '0')}.json`), record);
    onCommitted();
    await this.audit(record.state.id, { category: 'round.committed', round: record.round, day: record.state.day, attemptId: record.attemptId, data: { stateHash: record.hash, auditHash: record.auditHash } });
    await this.save(checkpoint);
    if (record.state.result) await this.exportChronicle(record.state.id);
  }

  async load(id: string, round?: number): Promise<Checkpoint & { hash: string }> {
    const directory = this.directory(id);
    let value: unknown;
    if (round === undefined) {
      const files = (await readdir(directory)).filter(file => /^round-\d{4}\.json$/.test(file)).sort();
      let cache: Checkpoint & { hash?: string } | undefined;
      try { cache = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const latest = files.at(-1);
      if (cache?.hash && cache.hash !== stateHash(cache.state)) {
        if (!latest) throw new Error('存档状态哈希不一致，文件可能损坏');
        cache = undefined;
      }
      if (latest) {
        const record = JSON.parse(await readFile(join(directory, latest), 'utf8')) as TurnRecord;
        value = { version: record.state.version, state: record.state, hash: record.hash, lastDecisions: record.decisions, metrics: record.metrics ?? cache?.metrics ?? {} };
      } else value = JSON.parse(await readFile(join(directory, 'initial.json'), 'utf8'));
      const logs = await this.auditRecords(id);
      for (const file of files) {
        const record = JSON.parse(await readFile(join(directory, file), 'utf8')) as TurnRecord;
        if (record.hash !== stateHash(record.state)) throw new Error(`存档状态哈希不一致：${file}`);
        if (record.auditHash && !logs.some(log => log.hash === record.auditHash && log.attemptId === record.attemptId && log.category === 'round.prepared' && (log.data as { hash?: string }).hash === record.hash)) throw new Error(`回合与审计日志不一致：${file}`);
      }
    }
    else {
      if (!Number.isInteger(round) || round < 0 || round > 1000) throw new Error('存档轮数无效');
      const initial = JSON.parse(await readFile(join(directory, 'initial.json'), 'utf8')) as Checkpoint;
      if (round === initial.state.round) value = initial;
      else {
        const record = JSON.parse(await readFile(join(directory, `round-${String(round).padStart(4, '0')}.json`), 'utf8')) as TurnRecord;
        value = { version: record.state.version, state: record.state, lastDecisions: record.decisions, hash: record.hash, metrics: record.metrics ?? Object.fromEntries(Object.keys(record.decisions).map(factionId => [factionId, record.decisions[factionId as FactionId].metrics])) };
      }
    }
    const checkpoint = value as Checkpoint & { hash?: string };
    if (![1, 2, 3, 4, 5].includes(checkpoint.version) || ![1, 2, 3, 4, 5].includes(checkpoint.state?.version) || !checkpoint.state.config || checkpoint.state.id !== id) throw new Error('不支持的存档格式');
    const hash = stateHash(checkpoint.state);
    if (checkpoint.hash && checkpoint.hash !== hash) throw new Error('存档状态哈希不一致，文件可能损坏');
    return { ...checkpoint, hash };
  }

  async list(): Promise<MatchMeta[]> {
    await mkdir(this.root, { recursive: true });
    const directories = await readdir(this.root, { withFileTypes: true });
    const result = await Promise.all(directories.filter(directory => directory.isDirectory() && /^[A-Za-z0-9_-]{1,100}$/.test(directory.name)).map(async directory => {
      try { return JSON.parse(await readFile(join(this.root, directory.name, 'meta.json'), 'utf8')) as MatchMeta; }
      catch { return null; }
    }));
    return result.filter((meta): meta is MatchMeta => !!meta).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  }

  async record(id: string, round: number): Promise<TurnRecord> {
    this.directory(id);
    if (!Number.isInteger(round) || round < 1 || round > 1000) throw new Error('轮数无效');
    return JSON.parse(await readFile(join(this.directory(id), `round-${String(round).padStart(4, '0')}.json`), 'utf8')) as TurnRecord;
  }

  private async committedRecords(id: string) {
    const files = (await readdir(this.directory(id))).filter(file => /^round-\d{4}\.json$/.test(file)).sort();
    return Promise.all(files.map(async file => {
      const record = JSON.parse(await readFile(join(this.directory(id), file), 'utf8')) as TurnRecord;
      if (stateHash(record.state) !== record.hash) throw new Error(`存档状态哈希不一致：${file}`);
      return record;
    }));
  }

  async queryAudit(id: string, filter: { after?: number; limit?: number; factionId?: string; systemId?: string; category?: string; attemptId?: string; fromDay?: number; toDay?: number } = {}) {
    const records = await this.auditRecords(id);
    const turns = await this.committedRecords(id);
    const committed = new Set(turns.map(turn => turn.attemptId));
    const selected = records.filter(record => record.seq > (filter.after ?? 0) && (!filter.factionId || record.factionId === filter.factionId || (record.data as { audience?: string[] })?.audience?.includes(filter.factionId)) && (!filter.systemId || record.systemId === filter.systemId) && (!filter.category || record.category.startsWith(filter.category)) && (!filter.attemptId || record.attemptId === filter.attemptId) && (filter.fromDay === undefined || record.day >= filter.fromDay) && (filter.toDay === undefined || record.day <= filter.toDay));
    const page = selected.slice(0, Math.min(200, Math.max(1, filter.limit ?? 50)));
    return { coverage: records.length ? '完整审计：公开输入输出；事实以原子回合文件为准' : '旧存档：只有逐轮快照和保留的事件，原始请求及截断事件缺失', total: records.length, matched: selected.length, next: selected.length > page.length ? page.at(-1)?.seq : null, records: page.map(record => ({ ...record, committed: record.attemptId ? committed.has(record.attemptId) : null })) };
  }

  async exportAudit(id: string) {
    const records = await this.auditRecords(id);
    if (records.length) return records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const turns = await this.committedRecords(id);
    return [{ category: 'legacy.coverage', data: '旧档仅含快照；缺失原始请求及完整事件，不补造历史' }, ...turns.map(turn => ({ category: 'legacy.round', data: sanitize(turn) }))].map(record => JSON.stringify(record)).join('\n') + '\n';
  }

  async exportChronicle(id: string) {
    const initial = JSON.parse(await readFile(join(this.directory(id), 'initial.json'), 'utf8')) as Checkpoint & { hash?: string };
    if (initial.hash && initial.hash !== stateHash(initial.state)) throw new Error('初始状态哈希不一致');
    const turns = await this.committedRecords(id);
    const logs = await this.auditRecords(id);
    const committed = new Set(turns.map(turn => turn.attemptId));
    const lines = [`# WAR In Stars 编年史`, '', `比赛：${id}；种子：${initial.state.config.seed}；规则版本：${initial.state.version} / 修订 ${initial.state.rulesRevision ?? '原版'}`, '', logs.length ? '记录范围：本分支开局至最近提交回合。模型公开说明为当时意图，游戏事件为结算事实。序号对应 audit.jsonl。' : '记录范围：旧版逐轮快照。原始模型请求、失败尝试与被截断事件缺失，无法补还。', ''];
    if (initial.state.lineage) lines.push(`历史来源：${initial.state.lineage.matchId}，第${initial.state.lineage.round}轮，状态哈希 ${initial.state.lineage.hash}`, '');
    lines.push('## 开局', '', ...Object.values(initial.state.factions).map(faction => `- ${faction.name}（${faction.id}），模型 ${initial.state.config.models[faction.id]}，母星 ${faction.homeSystemId}`), '', `初始状态哈希：${stateHash(initial.state)}`, '');
    const seen = new Set<string>();
    for (const turn of turns) {
      lines.push(`## 第${Math.floor(turn.state.day / RULES.daysPerYear) + 1}年 · 第${turn.round}轮 · 第${turn.state.day}日`, '', `状态哈希：${turn.hash}；决策尝试：${turn.attemptId ?? '旧档未记录'}`, '');
      for (const [factionId, decision] of Object.entries(turn.decisions)) {
        const source = logs.find(log => log.attemptId === turn.attemptId && log.factionId === factionId && log.category === 'decision.completed');
        const rejected = decision.trace.filter(trace => !trace.ok || trace.disposition === 'rolled_back');
        if (rejected.length) lines.push(`本次决策存在 ${rejected.length} 条拒绝或回滚记录，均非执行事实；以最终接受命令及世界事件为准。`, '');
        lines.push(`### ${turn.state.factions[factionId].name}的公开战略（${source ? `审计 #${source.seq}` : '逐轮存档'}）`, '', ...decision.summary.split('\n').map(line => `> ${line}`), '', `意图：${decision.actions.map(action => action.type).join('、') || '无命令'}。最终执行情况见本轮命令事件。`, '');
      }
      const events = logs.length ? logs.filter(log => log.attemptId === turn.attemptId && log.category.startsWith('event.')).map(log => ({ event: log.data as GameState['events'][number], source: `审计 #${log.seq}` })) : turn.state.events.filter(event => !seen.has(event.id)).map(event => ({ event, source: '旧快照' }));
      for (const { event, source } of events) {
        seen.add(event.id);
        lines.push(`- 第${event.day}日 · ${event.text}（${source}）`);
        if (event.type === 'battle' && event.details) lines.push(...battleSummary(event.details, turn.state.factions));
      }
      lines.push('', '### 经济变化', '');
      for (const faction of Object.values(turn.state.factions)) lines.push(`- ${faction.name}：凝聚力 ${(faction.unity / 100).toFixed(2)}；本轮净收支 电力 ${faction.lastIncome.energy / 1000} / 食物 ${faction.lastIncome.food / 1000} / 矿物 ${faction.lastIncome.minerals / 1000}${industrial(turn.state) ? ' / 合金 ' + (faction.lastIncome.alloys ?? 0) / 1000 : ''}；库存 ${JSON.stringify(Object.fromEntries(Object.entries(faction.resources).map(([resource, amount]) => [resource, amount / 1000])))}`);
      lines.push('');
    }
    lines.push('## 未提交尝试与资料缺口', '');
    const attempts = [...new Set(logs.filter(log => log.attemptId && !committed.has(log.attemptId)).map(log => log.attemptId!))];
    for (const attempt of attempts) {
      lines.push(`### 尝试 ${attempt}（未提交，不作为历史事实）`, '');
      for (const log of logs.filter(record => record.attemptId === attempt && ['attempt.started', 'attempt.aborted', 'model.failure', 'decision.completed'].includes(record.category))) lines.push(`- 审计 #${log.seq}，第${log.day}日，${log.category}：${JSON.stringify(log.data)}`);
      lines.push('');
    }
    if (!attempts.length) lines.push(logs.length ? '未发现未提交尝试。' : '旧档未记录失败和中断过程。');
    const latest = turns.at(-1)?.state ?? initial.state;
    if (revised(latest)) {
      lines.push('', '## 宿敌、征服准备与战争成果', '', `规则修订${latest.rulesRevision}；新增进度与成果按实际规则迁移日期累计。`);
      for (const rivalry of Object.values(latest.rivalries ?? {})) lines.push('- 宿敌进度：' + JSON.stringify(rivalry));
      for (const preparation of latest.conquests ?? []) lines.push('- 公开征服准备：' + JSON.stringify(preparation));
      for (const achievement of latest.warAchievements ?? []) lines.push('- 已执行战争成果：' + JSON.stringify(achievement));
      for (const actor of Object.keys(latest.factions)) lines.push('- ' + latest.factions[actor].name + '评分分解：' + JSON.stringify({...scoreBreakdown(latest, actor),...(governed(latest)?{governance:governanceView(latest,actor)}:{})}));
    }
    if (balancedRules(latest)) {
      lines.push('', '## 吞并整合与文明成果', '', '吞并和整合完成分开记录；任期成果永久去重，圣地分随当前法理与控制状态变化。详见对应事件的审计序号。');
      for (const system of latest.systems.filter(system => system.annexation)) lines.push(`- ${system.name}吞并整合：${JSON.stringify(system.annexation)}`);
      for (const award of latest.civilizationAwards ?? []) lines.push(`- 第${award.day}日文明成果：${JSON.stringify(award)}（来源：已提交状态，去重键 ${award.dedupKey}）`);
    }
    if(modern(latest)) {
      lines.push('', '## 永久文明路线与民众待遇', '', '最高待遇只表示福利承诺；须通过民生考核并明确提交永久命令才建立乌托邦。战争与民生资格独立，福利按实际兑现记录。');
      for(const f of Object.values(latest.factions)) lines.push(`- ${f.name}：制度 ${JSON.stringify(f.civilization)}；待遇 ${f.welfare?.choice}；最近十日账单 ${JSON.stringify(f.welfare?.last)}。金额为内部定点单位（/1000），来源：已提交第${latest.round}轮状态。`);
      for(const log of logs.filter(l=>committed.has(l.attemptId)&&l.category==='event.beacon')) lines.push(`- 审计 #${log.seq}：${JSON.stringify(log.data)}`);
    }
    if(responsible(latest)){
      lines.push('','## 创教资格、文明责任与民生救援','','仅已提交世界事实。提案、接受、实际支付与履责完成分别记录；空宣战和未提交意图不是成果。');
      for(const [kind,values]of Object.entries({founders:latest.social?.founders,reports:latest.social?.reports,concerns:latest.social?.concerns,aid:latest.social?.aid,reforms:latest.social?.reforms}))lines.push(`- ${kind}：${JSON.stringify(values)}（来源：已提交第${latest.round}轮状态）`);
      for(const f of Object.values(latest.factions))lines.push(`- ${f.name}责任：${JSON.stringify(f.responsibility)}；失败命令事实：${JSON.stringify(f.failedOrders??{})}`);
      for(const log of logs.filter(l=>committed.has(l.attemptId)&&['event.beacon','event.war','event.religion'].includes(l.category)))if(/责任|援助|改革|创教/.test(JSON.stringify(log.data)))lines.push(`- 审计 #${log.seq}：${JSON.stringify(log.data)}`);
    }
    if (industrial(latest)) lines.push('', '## 人口岗位与产业转型', '', '建设完成仅表示设施存在；运营由当时人口和优先级决定。开始/停止运营及封存详见事件审计，原料分配详见economy.step。矿物与合金合并储备分上限400。');
    if (latest.version >= 4) {
      lines.push('', '## 战争及和约', '');
      for (const war of latest.wars ?? []) lines.push(`- ${war.id}：${WAR_NAMES[war.type]}；${war.factions.join(' / ')}；第${war.startedDay}日开始，${war.endedDay === undefined ? '尚未结束' : `第${war.endedDay}日结束：${war.outcome}`}；目标与结果 ${JSON.stringify(war.goals)}。事实出处：已提交回合 ${turns.at(-1)?.round ?? initial.state.round}。`);
      lines.push('', '## 国教与圣地', '');
      for (const faction of Object.values(latest.factions)) if (faction.faith) lines.push(`### ${faction.name} · ${faction.faith.name}`, '', `第${faction.faith.establishedDay}日永久立教；当前危机 ${faction.faith.crisis}；圣地 ${JSON.stringify(faction.faith.sites)}`, '', '公开教义原文（出处：已提交状态；文字不产生额外能力）：', '', ...faction.faith.doctrine.split('\n').map(line => `> ${line}`), '');
      lines.push('', '## 文明灯塔与任期成果', '');
      for (const faction of Object.values(latest.factions)) lines.push(`- ${faction.name}：历史最高 ${faction.beacon?.highest ?? 0} 级；当前连续合格乌托邦 ${faction.beacon?.streak ?? 0} 届。`);
    }
    lines.push('', '## 结局', '', latest.result ? `胜方：${latest.result.winner ? latest.factions[latest.result.winner].name : '平局'}；原因：${latest.result.reason}；评分：${JSON.stringify(latest.result.scores)}` : `截至第${latest.round}轮，比赛尚未结束。`, '');
    const markdown = sanitize(lines.join('\n'));
    const target = join(this.directory(id), 'chronicle.md');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, markdown, 'utf8'); await rename(temporary, target);
    return markdown;
  }
}
