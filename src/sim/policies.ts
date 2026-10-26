import { modern } from '../shared/civilization.js';
import { POLICIES } from '../shared/civil.js';
import { factionIds, RULES } from '../shared/rules.js';
import type { GameState } from '../shared/types.js';

export function updatePolicies(state: GameState) {
  const term = Math.floor(state.day / RULES.policyDays);
  for (const id of factionIds(state)) {
    const faction = state.factions[id];
    if (faction.eliminatedDay !== undefined) continue;
    const previous = faction.policy;
    if (previous?.term === term && previous.locked) continue;
    const choice = previous?.term === term ? previous.choice : previous?.next?.term === term ? previous.next.choice : 'none';
    const explicit = previous?.term === term ? previous.explicit : previous?.next?.term === term;
    if (!modern(state) && choice !== 'utopia' && faction.beacon?.streak) {
      state.events.push({ id: `${state.day}-beacon-fall-${id}`, day: state.day, round: state.round + 1, type: 'beacon', systemId: null, audience: [id], text: `${faction.name}中断乌托邦，文明灯塔奖励停止`, details: { previousStreak: faction.beacon.streak } });
      faction.beacon.streak = 0;
    }
    faction.policy = { term, choice, explicit, locked: true };
    state.events.push({ id: `${state.day}-policy-${id}-${term}`, day: state.day, round: state.round + 1, type: 'policy', systemId: null, audience: [id], text: `${faction.name}第${term + 1}届政策：${POLICIES[choice].name}（${explicit ? '明确选择' : '未提交，默认跳过'}），至第${(term + 1) * RULES.policyDays}日`, details: { factionId: id, term, choice, explicit, startsDay: term * RULES.policyDays, endsDay: (term + 1) * RULES.policyDays } });
  }
}
