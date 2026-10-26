import { balancedRules, integrating } from '../shared/balance.js';
import type { GameState } from '../shared/types.js';
import type { War } from '../shared/v4.js';
import { v4Event } from '../shared/v4.js';
import { ESCALATION, endConquest, revised } from '../shared/escalation.js';
import { relationKey, relationship } from '../shared/diplomacy.js';
import { RULES } from '../shared/rules.js';

export function recordRivalry(state: GameState, war: War) {
  if (!revised(state) || war.type === 'contact' || !war.hadHostilities) return;
  const key = relationKey(...war.factions);
  const rivalry = (state.rivalries ??= {})[key] ??= { factions: [...war.factions], warIds: [], freePeaceDays: 0 };
  if (rivalry.warIds.includes(war.id)) return;
  rivalry.warIds.push(war.id); rivalry.freePeaceDays = 0;
  v4Event(state, 'war', rivalry.warIds.length >= ESCALATION.rivalryWars ? '宿敌战争累计：双方获得总体战理由，仍须遵守休战条约' : '正式战争计入宿敌进度', war.factions, rivalry);
}
export function awardAchievement(state: GameState, entry: NonNullable<GameState['warAchievements']>[number]) {
  if (!revised(state)) return;
  const entries = state.warAchievements ??= [];
  if (entries.some(item => item.actor === entry.actor && item.systemId === entry.systemId && item.type === entry.type && (entry.type === 'territory' || item.target === entry.target))) return;
  entries.push(entry);
  v4Event(state, 'war', entry.type === 'territory' ? balancedRules(state) && state.systems.some(system => system.id === entry.systemId && integrating(system)) ? '领土战争成果登记：吞并整合完成且仍持有时计100分' : '领土战争成果登记：持有时计100分' : '战争目标成果登记：50分，全国非领土成果上限500分', [entry.actor, entry.target], entry, entry.systemId);
}
export function updateEscalation(state: GameState, elapsed: number = RULES.tickDays) {
  if (!revised(state)) return;
  const start = state.day - elapsed;
  for (const rivalry of Object.values(state.rivalries ?? {}).sort((first, second) => relationKey(...first.factions).localeCompare(relationKey(...second.factions)))) {
    const relation = relationship(state, ...rivalry.factions)!;
    const before = rivalry.freePeaceDays;
    if (relation.status === 'war') rivalry.freePeaceDays = 0;
    else if (relation.status === 'peace') rivalry.freePeaceDays += Math.max(0, state.day - Math.max(start, relation.pactUntil ?? 0));
    if (rivalry.freePeaceDays >= ESCALATION.freePeaceDays) {
      v4Event(state, 'war', '自由和平满1080日：宿敌与战争累计清除', rivalry.factions, rivalry);
      delete state.rivalries![relationKey(...rivalry.factions)];
    } else if (before !== rivalry.freePeaceDays) v4Event(state, 'war', '宿敌自由和平计时', rivalry.factions, rivalry);
  }
  for (const item of state.conquests ?? []) {
    if (item.endedDay !== undefined) continue;
    const relation = relationship(state, item.actor, item.target);
    if ([item.actor, item.target].some(id => state.factions[id].eliminatedDay !== undefined)) { endConquest(state, item, '势力淘汰'); continue; }
    if (relation?.status !== 'peace') { endConquest(state, item, '双方关系进入战争或不再和平'); continue; }
    if (item.readyDay > state.day) continue;
    if (!item.announcedReady) { item.announcedReady = true; v4Event(state, 'war', '征服准备成熟：可在条约到期后自行宣战', [item.actor, item.target], item); }
    const before = item.freePeaceDays;
    item.freePeaceDays += Math.max(0, state.day - Math.max(start, item.readyDay, relation.pactUntil ?? 0));
    if (item.freePeaceDays >= ESCALATION.readinessDays) endConquest(state, item, '成熟资格1080个自由和平日到期');
    else if (before !== item.freePeaceDays) v4Event(state, 'war', '征服资格自由和平计时', [item.actor, item.target], item);
  }
}
