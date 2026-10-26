import { governed, V53 } from '../shared/governance.js';
import { route } from '../shared/civilization.js';
import { v4Event } from '../shared/v4.js';
import type { GameState } from '../shared/types.js';
import { migrateResponsibilities } from './civilization.js';

export function releaseClaims(state: GameState) {
  if (!governed(state)) return;
  state.claims = (state.claims ?? []).filter(claim => {
    const system = state.systems.find(s => s.id === claim.systemId);
    const active = claim.expiresDay > state.day && !!system?.ownerId && system.ownerId === claim.targetId && system.ownerId !== claim.factionId;
    if (!active) v4Event(state, 'war', '宣称已完成或失效，释放活动额度', [claim.factionId], { claim, reason: system?.ownerId === claim.factionId ? '已获得法理主权' : '失效' });
    return active;
  });
}
export function annexationProgress(state: GameState, actor: string, previousOwner: string, systemId: string, warId: string) {
  if (!governed(state) || route(state, actor) !== 'militarist') return;
  const war = state.wars?.find(w => w.id === warId);
  if (!war || war.type !== 'total' || war.endedDay !== undefined || !war.factions.includes(previousOwner) || !war.factions.includes(actor) || previousOwner === actor) return;
  const faction = state.factions[actor], duty = faction.responsibility;
  if (!duty) return;
  // Recovering formerly owned territory is not a new expansion, even when no
  // stage award existed before migration or when the loss occurred in an earlier war.
  if (faction.homeSystemId === systemId || (state.cessions ?? []).some(c => c.systemId === systemId && c.from === actor)) return;
  const progress = faction.annexationProgress ??= { systems: [], wars: {} };
  if (progress.systems.includes(systemId)) return;
  progress.systems.push(systemId);
  const buffer = progress.wars[warId] ??= { granted: 0, remaining: 0 };
  const granted = Math.min(V53.annexationBuffer, V53.annexationBufferCap - buffer.granted);
  buffer.granted += granted; buffer.remaining += granted;
  const before = duty.dissatisfaction;
  duty.dissatisfaction = Math.max(0, before - V53.annexationRelief);
  v4Event(state, 'war', '总体战正式吞并：军国阶段战果降压', [actor], { source: warId, systemId, key: JSON.stringify([actor, systemId]), before, after: duty.dissatisfaction, granted, buffer: { ...buffer } });
}
export function migrateGovernance(original: GameState): GameState {
  if (original.result) throw new Error('已结束比赛不能迁移继续运行');
  if (governed(original)) return structuredClone(original);
  const state = migrateResponsibilities(original);
  state.rulesRevision = '5.3';
  for (const faction of Object.values(state.factions)) {
    faction.governance = [];
    faction.annexationProgress = { systems: [], wars: {} };
  }
  releaseClaims(state);
  v4Event(state, 'beacon', '显式迁移5.3：治理样本从现在累计，不补发阶段战果；保留项目预付款与进度', Object.keys(state.factions), { from: original.rulesRevision, revision: '5.3', day: state.day });
  return state;
}
