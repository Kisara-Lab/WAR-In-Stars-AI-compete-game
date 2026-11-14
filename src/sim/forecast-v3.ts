import { RESPONSIBILITY as RULES } from '../shared/responsibility.js';
import { supportedAt } from '../shared/emergency.js';
import type { GameState } from '../shared/types.js';

export interface ForecastScenario {
  actionable: boolean;
  successDay?: number;
  rescueDueDay?: number;
}

export function forecastResponsibility(state: GameState, actor: string, scenario: ForecastScenario) {
  const faction = state.factions[actor], duty = faction.responsibility;
  if (!duty) return;
  const start = state.day - 10, kind = faction.civilization?.choice;
  if(kind==='theocracy'&&duty.satisfiedUntil>start&&!(scenario.successDay!==undefined&&start>=scenario.successDay)&&!state.missions?.some(mission=>duty.missionIds.includes(mission.id)&&mission.expiresDay>start))duty.satisfiedUntil=start;
  if (scenario.successDay !== undefined && start === scenario.successDay) {
    duty.satisfiedUntil = start + RULES.achievementDays;
    duty.dissatisfaction = 0;
    duty.overdueDays = 0;
    duty.ignored = false;
    duty.recovery = {startedDay:start,amount:duty.rescuePenalty};
  }
  const grace = kind === 'theocracy' ? RULES.religiousGrace : RULES.militaryGrace;
  const protectedDay = kind === 'theocracy' && supportedAt(faction.extraction, start);
  if (['theocracy', 'militarist'].includes(kind ?? '') && scenario.actionable && start >= duty.startedDay + grace && start >= duty.satisfiedUntil && !protectedDay) {
    const active=state.wars?.filter(war=>war.endedDay===undefined&&war.hadHostilities&&war.factions.includes(actor)&&(kind==='militarist'||war.attackers.includes(actor)&&war.goals[actor]?.some(goal=>goal.type==='missionary'&&!goal.invalid)))??[];
    const annexation=Object.entries(faction.annexationProgress?.wars??{}).find(([id,buffer])=>buffer.remaining>0&&state.wars?.some(war=>war.id===id&&war.endedDay===undefined));
    const fighting=active.find(war=>(duty.bufferedWars[war.id]??0)<RULES.battleBuffer);
    const pressure = kind === 'theocracy' ? (duty.overdueDays >= RULES.religiousEscalationDays ? RULES.religiousEscalatedPressure : RULES.religiousPressure) : RULES.militaryPressure;
    if(annexation)annexation[1].remaining=Math.max(0,annexation[1].remaining-10);
    else if(fighting)duty.bufferedWars[fighting.id]=(duty.bufferedWars[fighting.id]??0)+10;
    else {
      duty.overdueDays += 10;
      if (kind === 'theocracy') faction.faith!.pending.push({reason: '预测：无新传教成果', amount: pressure / 10});
      else duty.dissatisfaction = Math.min(100, duty.dissatisfaction + pressure / 10);
    }
  }
  if(!duty.ignored&&duty.recovery)duty.rescuePenalty=Math.max(0,duty.recovery.amount*(1-(state.day-duty.recovery.startedDay)/RULES.penaltyRecoveryDays));
  if (kind === 'utopia' && scenario.rescueDueDay !== undefined && start >= scenario.rescueDueDay && !(scenario.successDay !== undefined && start >= scenario.successDay)) {
    duty.ignored = true;
    duty.rescuePenalty = Math.min(RULES.rescuePenaltyCap, duty.rescuePenalty + RULES.rescuePenaltyPer100 / 10);
    if (faction.beacon) { faction.beacon.disqualified = true; faction.beacon.streak = 0; }
  }
}
