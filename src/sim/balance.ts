import { emergencyRules, extractingAt } from '../shared/emergency.js';
import { modernRules } from '../shared/responsibility.js';
import { BALANCE, balancedRules, civilizationScore, firstCompleteTerm, integrating } from '../shared/balance.js';
import { RULES, factionIds } from '../shared/rules.js';
import type { GameState } from '../shared/types.js';
import { occupied, v4Event } from '../shared/v4.js';
import type { FactionFactors } from './local.js';

export function awardCivilization(state: GameState, actor: string, category: 'utopia' | 'faith', term: number, evidence: unknown) {
  if (!balancedRules(state) || term < firstCompleteTerm(state)) return;
  const dedupKey = `${actor}:${category}:${term}`;
  const awards = state.civilizationAwards ??= [];
  if (awards.some(award => award.dedupKey === dedupKey)) return;
  awards.push({ actor, category, term, day: state.day, dedupKey });
  v4Event(state, 'beacon', `${state.factions[actor].name}获得${category === 'utopia' ? '乌托邦' : '稳定信仰'}任期文明成果100分（全国文明分上限1500）`, [actor], { dedupKey, category, term, score: BALANCE.termScore, evidence });
}
export function finishBalanceInterval(state: GameState, previous: Record<string, FactionFactors>, controlled: Record<string, string | null>) {
  if (!balancedRules(state)) return;
  for (const system of state.systems) if (integrating(system) && !occupied(system) && controlled[system.id] === system.ownerId && system.annexation!.startedDay <= state.day - RULES.tickDays) {
    const annexation = system.annexation!;
    annexation.controlledDays = Math.min(BALANCE.annexationDays, annexation.controlledDays + RULES.tickDays);
    if (annexation.controlledDays === BALANCE.annexationDays) {
      annexation.completedDay = state.day;
      v4Event(state, 'war', `${system.name}吞并整合完成，恢复正常生产与领土成果计分`, [system.ownerId!], { annexation }, system.id);
    }
  }
  const term = Math.floor((state.day - RULES.tickDays) / RULES.policyDays);
  for (const actor of factionIds(state)) {
    const faction = state.factions[actor];
    if (faction.eliminatedDay !== undefined) continue;
    const sacred = civilizationScore(state, actor);
    const beforeHoly = previous[actor].holyScore ?? sacred.main + sacred.secondary;
    if (beforeHoly !== sacred.main + sacred.secondary) v4Event(state, 'beacon', `${faction.name}圣地当前状态分 ${beforeHoly} → ${sacred.main + sacred.secondary}（失守暂失，收复恢复，不累加）`, [actor], { before: beforeHoly, after: sacred.main + sacred.secondary, cap: BALANCE.civilizationCap });
    const tracker = faction.stableFaith ??= { term, totalDays: 0, qualifiedDays: 0, wholeTerm: state.day - RULES.tickDays === term * RULES.policyDays };
    tracker.totalDays += RULES.tickDays;
    if (emergencyRules(state) && extractingAt(faction.extraction,state.day-RULES.tickDays)) tracker.wholeTerm=false;
    tracker.wholeTerm &&= !!previous[actor].faith && previous[actor].faith!.establishedDay <= term * RULES.policyDays;
    if (previous[actor].stableFaithInterval && (!modernRules(state) || faction.welfare?.last?.fraction === 1)) tracker.qualifiedDays += RULES.tickDays;
    if (state.day % RULES.policyDays) continue;
    const qualified = tracker.wholeTerm && tracker.totalDays === RULES.policyDays && tracker.qualifiedDays / RULES.policyDays >= BALANCE.qualifiedSupply;
    if (faction.faith) v4Event(state, 'beacon', `${faction.name}稳定信仰任期${qualified ? '合格' : '未合格'}`, [actor], { ...tracker, qualified });
    if (qualified) awardCivilization(state, actor, 'faith', term, { ...tracker });
    faction.stableFaith = { term: term + 1, totalDays: 0, qualifiedDays: 0, wholeTerm: true };
  }
}
export function migrateBalance(original: GameState): GameState {
  const state = structuredClone(original);
  if (balancedRules(state)) return state;
  if (state.result) throw new Error('已结束比赛保留原结果，不能创建继续运行的4.2分支');
  const previousRevision = state.rulesRevision ?? '4.0';
  state.rulesRevision = '4.2'; state.balanceStartedDay = state.day; state.civilizationAwards = [];
  state.rivalries ??= {}; state.conquests ??= []; state.warAchievements ??= [];
  for (const faction of Object.values(state.factions)) delete faction.stableFaith;
  v4Event(state, 'beacon', '显式迁移至4.2：战争开支从今日生效；不追补吞并整合或过去任期成果', factionIds(state), { previousRevision, revision: '4.2', fromDay: state.day, firstCompleteTerm: firstCompleteTerm(state) });
  return state;
}
