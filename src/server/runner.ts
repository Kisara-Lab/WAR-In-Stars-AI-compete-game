import { migrateEmergency } from '../sim/emergency.js';
import { migrateGovernance } from '../sim/governance.js';
import { migrateCivilization, migrateDecisionBalance, migrateResponsibilities } from '../sim/civilization.js';
import { sanitize } from './audit.js';
import type { AuditInput } from './audit.js';
import { migrateIndustry } from '../sim/industry.js';
import { migrateBalance } from '../sim/balance.js';
import { observation } from '../sim/intel.js';
import { randomUUID } from 'node:crypto';
import { factionIds, factionRecord } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Decision, DecisionMetrics, GameState, LiveSnapshot, LiveStatus, MatchConfig } from '../shared/types.js';
import { advanceRound } from '../sim/engine.js';
import { emptyMetrics, scriptedDecision } from '../sim/bot.js';
import { stateHash } from '../sim/math.js';
import { SimulationPool } from '../sim/pool.js';
import { migrateState } from '../sim/diplomacy.js';
import { createGame } from '../sim/world.js';
import type { ModelProvider } from './provider.js';
import { MatchStore } from './storage.js';
import type { Checkpoint } from './storage.js';

export class MatchRunner {
  state: GameState;
  lastDecisions: Record<FactionId, Decision> | null = null;
  status: LiveStatus;
  private pauseRequested = false;
  private attemptId: string | undefined;
  private audit(category: string, data: unknown, factionId?: string, day = this.state.day) {
    return this.store.audit(this.state.id, { category, data, factionId, day, round: this.state.round + (this.attemptId ? 1 : 0), attemptId: this.attemptId });
  }
  private abort: AbortController | null = null;
  private active: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(state: GameState, public pool: SimulationPool, readonly store: MatchStore, private providerFactory: () => Promise<ModelProvider>, private scriptController: typeof scriptedDecision = scriptedDecision, private scriptAuditProjection = true) {
    this.state = state;
    this.status = this.freshStatus();
  }

  private freshStatus(): LiveStatus {
    return { phase: 'ready', running: false, busy: false, error: null, ai: factionRecord(factionIds(this.state), id => ({ status: this.state.factions[id].eliminatedDay === undefined ? '等待决策' : '已淘汰', requests: 0, actions: 0 })), metrics: factionRecord(factionIds(this.state), emptyMetrics), workers: this.pool.metrics };
  }

  snapshot(): LiveSnapshot { return { state: this.state, status: { ...this.status, workers: this.pool.metrics }, lastDecisions: this.lastDecisions }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  private checkpoint() { return { version: this.state.version, state: this.state, lastDecisions: this.lastDecisions, metrics: this.status.metrics }; }
  async initialize() { await this.store.initialize(this.checkpoint()); }

  async recover(checkpoint: Checkpoint) {
    this.state = checkpoint.state;
    this.lastDecisions = checkpoint.lastDecisions;
    this.status = this.freshStatus();
    this.status.metrics = checkpoint.metrics;
    this.status.phase = this.state.result ? 'finished' : 'paused';
    // Finished archives are immutable, including their audit chain and file bytes.
    if (this.state.result) return;
    const records = await this.store.auditRecords(this.state.id);
    let reconciled=false;
    for (const start of records.filter(record => record.category === 'attempt.started')) {
      if (records.some(record => record.attemptId === start.attemptId && ['attempt.aborted', 'round.committed', 'round.recovered'].includes(record.category))) continue;
      const page = await this.store.queryAudit(this.state.id, { attemptId: start.attemptId, limit: 1 });
      reconciled=true;
      await this.store.audit(this.state.id, { category: page.records[0]?.committed ? 'round.recovered' : 'attempt.aborted', day: this.state.day, round: start.round, attemptId: start.attemptId, data: { reason: '进程重启，按原子回合文件对账', committed: page.records[0]?.committed ?? false, stateHash: stateHash(this.state) } });
    }
    // A clean, already committed boundary needs no archive rewrite on restart.
    // Recovery of interrupted attempts is still persisted and audited below.
    if(!reconciled)return;
    await this.audit('runtime.recovered', { stateHash: stateHash(this.state), round: this.state.round, paused: true });
    await this.store.save(this.checkpoint());
  }

  async create(config: MatchConfig, workers = this.pool.size) {
    if (this.status.busy || this.status.running || this.active) throw new Error('请先暂停并等待当前轮停止');
    const state = createGame(config);
    if (workers !== this.pool.size) {
      const replacement = new SimulationPool(workers);
      await this.pool.close(); this.pool = replacement;
    }
    this.state = state;
    this.lastDecisions = null;
    this.status = this.freshStatus();
    await this.initialize(); this.emit();
  }

  async load(id: string, round?: number, rulesRevision?: '4.2' | '4.3' | '5.0' | '5.1' | '5.2' | '5.3' | '5.4') {
    if (this.status.busy || this.status.running || this.active) throw new Error('请先暂停并等待当前轮停止');
    const checkpoint = await this.store.load(id, round);
    if(rulesRevision && Number(rulesRevision) < Number(checkpoint.state.rulesRevision ?? '4.0')) throw new Error('不能将较新规则存档降级；请选相同或更新修订创建分支');
    let restored = checkpoint.state.version >= 4 || !rulesRevision ? structuredClone(checkpoint.state) : migrateState(checkpoint.state);
    if (rulesRevision === '4.2') restored = migrateBalance(restored);
    if (rulesRevision === '4.3') restored = migrateIndustry(restored);
    if (rulesRevision === '5.0') restored = migrateCivilization(restored);
    if (rulesRevision === '5.1') restored = migrateDecisionBalance(restored);
    if (rulesRevision === '5.4') restored = migrateEmergency(restored);
    if (rulesRevision === '5.3') restored = migrateGovernance(restored);
    if (rulesRevision === '5.2') restored = migrateResponsibilities(restored);
    this.state = restored;
    this.state.lineage = { matchId: id, round: checkpoint.state.round, hash: checkpoint.hash, version: checkpoint.state.version };
    this.state.id = randomUUID();
    this.lastDecisions = checkpoint.lastDecisions;
    this.status = this.freshStatus();
    this.status.phase = this.state.result ? 'finished' : 'paused';
    this.status.metrics = checkpoint.metrics;
    await this.initialize();
    await this.audit('match.branch', { lineage: this.state.lineage, migrated: checkpoint.state.version !== this.state.version || checkpoint.state.rulesRevision !== this.state.rulesRevision, rulesRevision: this.state.rulesRevision });
    this.emit();
  }

  async save() {
    if (this.status.busy) throw new Error('本轮结束后可保存，上一轮已经自动保存');
    await this.store.save(this.checkpoint()); await this.audit('runtime.save', { hash: stateHash(this.state) }); return { id: this.state.id, round: this.state.round };
  }

  start(singleRound = false) {
    if (this.status.busy || this.active || this.status.running) throw new Error('比赛正在推进');
    if (this.state.result) throw new Error('比赛已经结束，请创建新比赛');
    this.pauseRequested = false;
    this.status.running = !singleRound;
    this.status.error = null;
    this.status.busy = true;
    this.active = this.loop(singleRound).finally(() => { this.active = null; this.status.busy = false; this.emit(); });
    this.emit();
  }

  pause() {
    this.pauseRequested = true;
    void this.audit('runtime.pause_requested', { busy: this.status.busy }).catch(error => { this.status.error = `审计写入失败：${error instanceof Error ? error.message : '未知错误'}`; this.status.phase = 'error'; this.status.running = false; this.emit(); });
    this.status.running = false;
    this.abort?.abort('user_pause');
    if (!this.status.busy) this.status.phase = this.state.result ? 'finished' : 'paused';
    this.emit();
  }

  async waitIdle() { await this.active; }

  private async loop(singleRound: boolean) {
    try {
      await this.store.resumeAudit(this.state.id);
      await this.audit('runtime.resume', { singleRound, stateHash: stateHash(this.state) });
      if (this.pauseRequested) return;
      do { await this.runRound(); } while (this.status.running && !this.state.result && !singleRound);
    } catch (error) {
      this.status.running = false;
      this.status.error = sanitize(error instanceof Error ? error.message : '比赛推进失败');
      this.status.phase = 'error';
    } finally {
      try {
        if (this.attemptId) await this.audit('attempt.aborted', { submitted: false, reason: this.abort?.signal.reason ?? this.status.error ?? '比赛中断' });
        await this.audit(this.state.result ? 'runtime.finished' : this.status.error ? 'runtime.error' : 'runtime.paused', { error: this.status.error, hash: stateHash(this.state), reason: this.abort?.signal.reason });
      } catch (error) { this.status.error = `审计写入失败：${error instanceof Error ? error.message : '未知错误'}`; this.status.phase = 'error'; this.status.running = false; }
      this.attemptId = undefined;
      this.abort = null;
      if (this.state.result && this.status.phase !== 'error') { this.status.phase = 'finished'; this.status.running = false; }
      else if (this.status.phase !== 'error') this.status.phase = 'paused';
      try { await this.store.save(this.checkpoint()); }
      catch { this.status.error = '存档写入失败，请检查磁盘空间与目录权限'; this.status.phase = 'error'; this.status.running = false; }
      this.emit();
    }
  }

  private async runRound() {
    this.status.busy = true;
    this.status.phase = 'deciding';
    const abort = new AbortController();
    this.abort = abort;
    const base = this.state;
    this.attemptId = randomUUID();
    await this.audit('attempt.started', { stateHash: stateHash(base), controller: base.config.controller });
    const activeIds = factionIds(base).filter(id => base.factions[id].eliminatedDay === undefined);
    for (const factionId of activeIds) this.status.ai[factionId] = { status: base.config.controller === 'model' ? '准备连接模型' : '脚本规划中', requests: 0, actions: 0 };
    this.emit();
    let decisions: Record<FactionId, Decision>;
    if (base.config.controller === 'scripted') {
      for (const factionId of activeIds) await this.audit('script.input', observation(base, factionId,null,undefined,this.scriptAuditProjection), factionId);
      decisions = factionRecord(activeIds, id => this.scriptController(base, id));
      for (const factionId of activeIds) {
        this.status.ai[factionId] = { status: '命令已提交', requests: 0, actions: decisions[factionId].actions.length };
        this.status.metrics[factionId].durationMs += decisions[factionId].metrics.durationMs;
      }
    } else {
      const provider = await this.providerFactory();
      const requests = activeIds.map(async factionId => {
        let previous: DecisionMetrics = emptyMetrics();
        const updateMetrics = (metrics: DecisionMetrics) => {
          const total = this.status.metrics[factionId];
          for (const field of ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'durationMs'] as const) total[field] += metrics[field] - previous[field];
          total.unknownUsageRequests = (total.unknownUsageRequests ?? 0) + (metrics.unknownUsageRequests ?? 0) - (previous.unknownUsageRequests ?? 0);
          total.reportedModel = metrics.reportedModel;
          previous = { ...metrics };
          this.emit();
        };
        return provider.decide(base, factionId, abort.signal, (status, requests, actions) => { this.status.ai[factionId] = { status, requests, actions }; this.emit(); }, updateMetrics, async (category, data) => { await this.audit(category, sanitize(data), factionId); }, this.lastDecisions?.[factionId]?.trace.filter(trace => !trace.ok || trace.disposition === 'rolled_back').map(trace => ({ round: base.round, ...trace })) ?? []).then(async decision => { await this.audit('decision.completed', decision, factionId); return decision; }).catch(error => { abort.abort('peer_error'); throw error; });
      });
      const result = await Promise.allSettled(requests);
      const failed = result.find(item => item.status === 'rejected');
      if (failed?.status === 'rejected') {
        if (abort.signal.reason === 'user_pause') {
          this.status.phase = 'paused'; return;
        }
        const substantive = result.find(item => item.status === 'rejected' && item.reason instanceof Error && !item.reason.message.includes('比赛已暂停'));
        throw substantive?.status === 'rejected' ? substantive.reason : failed.reason;
      }
      decisions = Object.fromEntries(activeIds.map((id, index) => [id, (result[index] as PromiseFulfilledResult<Decision>).value]));
    }
    if (abort.signal.aborted) { this.status.phase = 'paused'; return; }
    decisions = sanitize(decisions);
    if (base.config.controller === 'scripted') for (const factionId of activeIds) await this.audit('decision.completed', decisions[factionId], factionId);
    this.status.phase = 'simulating'; this.emit();
    const next = await advanceRound(base, this.pool, factionRecord(activeIds, id => decisions[id].actions), async batch => {
      const common = { day: batch.day, round: base.round + 1, attemptId: this.attemptId };
      const records: AuditInput[] = [
        ...batch.events.map(event => ({ ...common, category: `event.${event.type}`, systemId: event.systemId ?? undefined, factionId: event.audience.length === 1 ? event.audience[0] : undefined, data: event })),
        ...batch.movements.map(data => ({ ...common, category: 'movement.step', factionId: (data as { factionId: string }).factionId, systemId: (data as { after: { systemId: string | null } }).after.systemId ?? undefined, data })),
        ...batch.economy.map(data => ({ ...common, category: 'economy.step', factionId: (data as { factionId: string }).factionId, data })),
      ];
      if (records.length) await this.store.auditMany(base.id, records);
    });
    if (abort.signal.aborted) { this.status.phase = 'paused'; return; }
    for (const factionId of activeIds) next.factions[factionId].strategies = [...next.factions[factionId].strategies, { round: next.round, text: decisions[factionId].summary }].slice(-5);
    const checkpoint = { version: next.version, state: next, lastDecisions: decisions, metrics: this.status.metrics };
    const hash = stateHash(next);
    const prepared = await this.audit('round.prepared', { hash, actions: Object.fromEntries(Object.entries(decisions).map(([id, decision]) => [id, decision.actions])) }, undefined, next.day);
    if (abort.signal.aborted) { this.status.phase = 'paused'; return; }
    await this.store.commit({ round: next.round, decisions, hash, state: next, attemptId: this.attemptId, auditHash: prepared.hash, metrics: structuredClone(this.status.metrics) }, checkpoint, () => { this.state = next; this.lastDecisions = decisions; this.attemptId = undefined; });
    this.emit();
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async close() { this.pause(); await this.waitIdle(); try { await this.save(); } finally { await this.pool.close(); } }
}
