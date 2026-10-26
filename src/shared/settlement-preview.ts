import { RULES } from './rules.js';
import type { GameState } from './types.js';
import { controller, V4 } from './v4.js';
import type { War } from './v4.js';

/** Only public war records, own control, and the actor's dated intelligence. */
export function settlementPreview(state: GameState, actor: string, war: War) {
  if (!war.factions.includes(actor)) return null;
  const f = state.factions[actor], target = war.factions.find(id => id !== actor)!;
  const known = (id: string) => {
    const real = state.systems.find(s => s.id === id);
    if (real && (real.ownerId === actor || controller(real) === actor)) return real;
    const intel = f.intel[id]?.system, military = f.militaryIntel?.[id];
    return military ? { ...intel, ...military, id } : intel;
  };
  const returns = state.systems.filter(s => s.occupationWarId === war.id && (s.ownerId === actor || controller(s) === actor)).map(s => ({ systemId:s.id, from:controller(s), to:s.ownerId }));
  const retained = (state.cessions ?? []).filter(c => c.warId === war.id && c.to === actor && state.systems.some(s => s.id === c.systemId && s.ownerId === actor)).map(c => c.systemId);
  const goals = (war.goals[actor] ?? []).map(g => {
    const s = known(g.systemId);
    const eligible = !g.invalid && g.heldDays >= V4.holdDays && !!s && controller(s) === actor && (g.type === 'ideological' ? s.ownerId === actor : s.ownerId === target) && (g.type !== 'claim' || g.systemId !== state.factions[target].homeSystemId);
    return { systemId:g.systemId, type:g.type, heldDays:g.heldDays, requiredDays:V4.holdDays, eligible, result: !eligible ? '当前未达标，无成果' : g.type === 'claim' ? '正式割让，保留主权；须复核非母星及不消灭法理国家' : g.type === 'limited' ? '基地停用300日，赔偿0～200矿物（未知库存），不割地' : g.type === 'missionary' ? '1800日传教权，不割地' : g.type === 'humanitarian' ? '改革协议，不割地；长期实际履约另行评估' : '清除影响并保护1080日，不割地' };
  });
  const treatyUntil = state.day + RULES.nonAggressionDays;
  return { warId:war.id, actor, target, asOfDay:state.day,
    ...(state.rulesRevision==='5.4'&&Object.values(war.humanitarianReasons??{}).some(id=>id.startsWith('extraction-'))?{extraction:{unconditional:'无条件停战不会强制停止什四税，未完成停止目标或救援责任。',enforced:'连续控制声明基地200日可停止征收，转入剩余原期限内的民生恢复；归还占领，签1080日条约，连续360日合格才完整履责。'}}:{}),
    unconditional: { returnOccupations:returns, retainAnnexations:[...new Set(retained)], abandonedGoals:goals.map(g=>g.systemId), treatyUntil, responsibility: '未兑现目标不算成果；总体战已正式取得且仍保有的领土及成功防御按战后规则复核；主动无成果战争军方不满+20' },
    enforced: { goals, returnNonGoals:returns.filter(s=>!goals.some(g=>g.eligible&&g.type==='claim'&&g.systemId===s.systemId)), treatyUntil, responsibility:'仅实际兑现目标、保有总体战领土或成功防御认定完整军事成果；传教责任须有效传教权' },
    fatigueOrDeadline: { applies:war.type!=='total', deadline:war.type==='total'?null:war.startedDay+(war.type==='contact'?V4.contactDays:V4.warDays), goals, condition:'按结算时实际连续控制及目标合法性复核；当前进度不保证未来成果' },
    warning:'无条件停战归还临时占领，正式吞并与临时占领不同；不读取对方库存，第三方变化及最后领土限制在共同结算复核。' };
}
