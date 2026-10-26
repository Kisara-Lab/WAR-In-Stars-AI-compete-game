import { modernRules } from './responsibility.js';
import { CIVILIZATION, modern, route } from './civilization.js';
import type { GameState } from './types.js';
import { relationship, relationKey } from './diplomacy.js';
import { v4Event } from './v4.js';

export const ESCALATION = {
  revision: '4.1', rivalryWars: 3, freePeaceDays: 1080,
  preparationDays: 360, preparationMinerals: 300, preparationFood: 100,
  preparationUnity: 10, preparationUnityPer100: -2, readinessDays: 1080,
  suggestedPowerRatio: 1.5, fleetScoreFactor: 0.5, territoryScore: 100,
  objectiveScore: 50, objectiveScoreCap: 500,
} as const;
export interface Rivalry { factions: [string, string]; warIds: string[]; freePeaceDays: number }
export interface Conquest {
  id: string; actor: string; target: string; reason: string; startedDay: number;
  readyDay: number; freePeaceDays: number; announcedReady?: boolean;
  endedDay?: number; outcome?: string;
}
export interface WarAchievement { actor: string; target: string; systemId: string; type: 'territory' | 'limited' | 'missionary' | 'ideological' | 'humanitarian'; warId: string; day: number }
export const revised = (state: GameState) => state.rulesRevision === ESCALATION.revision || state.rulesRevision === '4.2' || state.rulesRevision === '4.3' || modernRules(state);

export function borders(state: GameState, actor: string, target: string, actual = false) {
  const faction = state.factions[actor];
  return state.systems.some(system => {
    const military = faction.militaryIntel?.[system.id];
    const local = faction.intel[system.id];
    const memory = military && (!local || military.day >= local.day) ? military : local?.system;
    const owner = actual ? system.ownerId : memory?.ownerId;
    return owner === target && system.neighbors.some(id => state.systems.find(candidate => candidate.id === id)?.ownerId === actor);
  });
}
export function conquestFor(state: GameState, actor: string) {
  return revised(state) ? state.conquests?.find(item => item.actor === actor && item.endedDay === undefined) : undefined;
}
export function warReasons(state: GameState, actor: string, actual = false) {
  const reasons = (state.grievances ?? []).filter(item => item.actor === actor && (item.active || item.expiresDay > state.day)).map(item => ({ ...item, usable: true, availableDay: Math.max(state.day, relationship(state, actor, item.target)?.pactUntil ?? 0), remainingFreePeaceDays: null as number | null }));
  if (!revised(state)) return reasons;
  for (const rivalry of Object.values(state.rivalries ?? {})) if (rivalry.factions.includes(actor) && rivalry.warIds.length >= ESCALATION.rivalryWars) {
    const target = rivalry.factions.find(id => id !== actor)!;
    reasons.push({ id: 'rivalry-' + relationKey(actor, target), actor, target, kind: 'rivalry', active: true, expiresDay: Number.MAX_SAFE_INTEGER, source: rivalry.warIds.join(','), usable: true, availableDay: Math.max(state.day, relationship(state, actor, target)?.pactUntil ?? 0), remainingFreePeaceDays: ESCALATION.freePeaceDays - rivalry.freePeaceDays });
  }
  const preparation = conquestFor(state, actor);
  if (preparation && preparation.readyDay <= state.day) reasons.push({
    id: preparation.id, actor, target: preparation.target, kind: 'conquest', active: true, expiresDay: Number.MAX_SAFE_INTEGER, source: preparation.id,
    usable: borders(state, actor, preparation.target, actual),
    availableDay: Math.max(state.day, relationship(state, actor, preparation.target)?.pactUntil ?? 0),
    remainingFreePeaceDays: ESCALATION.readinessDays - preparation.freePeaceDays,
  });
  return reasons;
}
export function escalationView(state: GameState, actor: string) {
  return revised(state) ? {
    rules: ESCALATION,
    rivalries: Object.values(state.rivalries ?? {}).filter(item => item.factions.includes(actor)).map(item => ({ ...item, pactUntil: relationship(state, ...item.factions)?.pactUntil, active: item.warIds.length >= ESCALATION.rivalryWars })),
    preparations: (state.conquests ?? []).filter(item => item.actor === actor || item.target === actor),
    reasons: warReasons(state, actor),
    achievements: (state.warAchievements ?? []).filter(item => item.actor === actor),
  } : undefined;
}

export function preparationRule(state: GameState, actor: string) { return modern(state) && route(state,actor)==='militarist' ? { minerals: CIVILIZATION.preparationMinerals, food: CIVILIZATION.preparationFood, unity: CIVILIZATION.preparationUnity, days: CIVILIZATION.preparationDays } : { minerals: ESCALATION.preparationMinerals, food: ESCALATION.preparationFood, unity: ESCALATION.preparationUnity, days: ESCALATION.preparationDays }; }
export function conquestOptions(state: GameState, actor: string) {
  const cost = preparationRule(state,actor);
  if (!revised(state)) return undefined;
  const faction = state.factions[actor];
  const preparation = conquestFor(state, actor);
  const reasons = warReasons(state, actor);
  return Object.values(state.relations).filter(relation => relation.factions.includes(actor) && relation.status !== 'unknown').map(relation => {
    const target = relation.factions.find(id => id !== actor)!;
    const knownBorder = borders(state, actor, target);
    const blockers: string[] = [];
    if(modern(state)&&route(state,actor)==='utopia') blockers.push('乌托邦禁止主动征服准备，但允许其他合法战争');
    if (state.factions[target].eliminatedDay !== undefined) blockers.push('目标已淘汰');
    if (relation.status !== 'peace') blockers.push('双方尚未正式和平');
    if (!knownBorder) blockers.push('己方情报未确认法理接壤');
    if (preparation) blockers.push('本方已有活动征服准备');
    if (faction.resources.minerals < cost.minerals * 1000) blockers.push(`矿物不足${cost.minerals}`);
    if (faction.resources.food < cost.food * 1000) blockers.push(`食物不足${cost.food}`);
    if (faction.unity < cost.unity * 100) blockers.push(`凝聚力不足${cost.unity}/100`);
    const targetReasons = reasons.filter(reason => reason.target === target);
    const canDeclare = state.factions[target].eliminatedDay === undefined && relation.status === 'peace' && targetReasons.some(reason => reason.usable && reason.availableDay <= state.day);
    return {
      timingExplanation: 'readyInDays=0表示准备成熟；pactRemainingDays=0表示无条约阻挡。readinessFreePeaceDaysRemaining是剩余有效期，不是开战前等待期。',
      cost, target, knownBorder, pactRemainingDays: Math.max(0, (relation.pactUntil ?? 0) - state.day),
      canPrepareNow: blockers.length === 0, prepareBlockers: blockers,
      canDeclareTotalNow: canDeclare,
      usableReasonIds: canDeclare ? targetReasons.filter(reason => reason.usable && reason.availableDay <= state.day).map(reason => reason.id) : [],
      preparation: preparation?.target === target ? { id: preparation.id, readyInDays: Math.max(0, preparation.readyDay - state.day), readinessFreePeaceDaysRemaining: ESCALATION.readinessDays - preparation.freePeaceDays } : null,
      earliestDeclarationAfterNewPreparation: blockers.length ? null : Math.max(state.day + cost.days, relation.pactUntil ?? 0),
      policyConsequence: modern(state) ? 'V5参战不使乌托邦评估失格；福利与供应决定资格。乌托邦不能准备征服。' : faction.policy?.choice === 'utopia' ? '乌托邦不禁止准备或总体战；主动发动总体战会使当前任期不合格，届末连续灯塔进度归零，需权衡机会成本。' : '无乌托邦当届资格损失。',
    };
  });
}
export function endConquest(state: GameState, item: Conquest, outcome: string) {
  if (item.endedDay !== undefined) return;
  item.endedDay = state.day; item.outcome = outcome;
  v4Event(state, 'war', '征服准备结束：' + outcome, [item.actor, item.target], item);
}
