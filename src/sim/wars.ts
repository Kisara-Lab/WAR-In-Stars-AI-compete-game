import { settleExtractionWars } from './emergency.js';
import { emergencyRules, extractingAt } from '../shared/emergency.js';
import { balancedRules, BALANCE } from '../shared/balance.js';
import { annexationProgress, releaseClaims } from './governance.js';
import { responsible, modernRules } from '../shared/responsibility.js';
import { enforceReform, liveReform, onWarResponsibility } from './social.js';
import { awardAchievement, recordRivalry } from './escalation.js';
import { revised } from '../shared/escalation.js';
import { BASE, RULES, SHIPS, factionIds, units } from '../shared/rules.js';
import { relationKey, relationship } from '../shared/diplomacy.js';
import { V4, WAR_NAMES, activeWar, controller, fleetValue, observeHolyControl, roundValue, v4Event } from '../shared/v4.js';
import type { War, WarGoal, WarType } from '../shared/v4.js';
import type { GameState, LocalEvent, StarSystem } from '../shared/types.js';

export function createWar(state: GameState, pair: [string, string], type: WarType, legacy = false): War {
  const record = (value: number) => Object.fromEntries(pair.map(id => [id, value]));
  const war: War = { id: `war-${relationKey(...pair)}-${state.day}-${state.wars?.length ?? 0}`, factions: [...pair].sort() as [string, string], type, startedDay: state.day, startedRound: state.round, legacy, attackers: [], reasons: {}, goals: Object.fromEntries(pair.map(id => [id, []])), fatigue: record(0), openingValue: Object.fromEntries(pair.map(id => [id, Math.max(V4.militaryFloor, fleetValue(state, id))])), lossWindow: Math.floor(state.day / 100), lossUsed: record(0) };
  (state.wars ??= []).push(war);
  if(responsible(state))war.openingTerritories=Object.fromEntries(pair.map(actor=>[actor,state.systems.filter(s=>s.ownerId===actor).map(s=>s.id)]));
  const relation = relationship(state, ...pair)!;
  if (revised(state) && state.rivalries?.[relationKey(...pair)]) state.rivalries[relationKey(...pair)].freePeaceDays = 0;
  relation.status = 'war'; relation.warDay = state.day; relation.warId = war.id; relation.offers = {};
  v4Event(state, 'war', `${WAR_NAMES[type]}开始`, pair, { war: structuredClone(war) });
  return war;
}

export function declareWar(state: GameState, actor: string, target: string, type: Exclude<WarType, 'contact'>, goals: string[], reason: string) {
  let war = activeWar(state, actor, target);
  if (war && (war.startedDay !== state.day || war.startedRound !== state.round || war.attackers.includes(actor))) throw new Error('战争中不能增加或改变目标');
  if (!war) war = createWar(state, [actor, target], type);
  if (type === 'total') war.type = 'total';
  war.attackers.push(actor); war.attackers.sort(); war.reasons[actor] = reason;
  war.goals[actor] = type === 'total' ? [] : goals.map(systemId => ({ systemId, type, heldDays: 0, heldSince: controller(state.systems.find(system => system.id === systemId)!) === actor && (type !== 'ideological' || !state.fleets.some(fleet => fleet.systemId === systemId && fleet.ownerId === target)) ? state.day : undefined }));
  if (type === 'total') {
    if (balancedRules(state)) { war.totalAttackers ??= []; if (!war.totalAttackers.includes(actor)) war.totalAttackers.push(actor); war.totalAttackers.sort(); }
    if (!modernRules(state) && state.factions[actor].beacon) state.factions[actor].beacon!.disqualified = true;
    (state.grievances ??= []).push({ id: `${war.id}-attacked-${target}`, actor: target, target: actor, kind: 'attacked', active: true, expiresDay: Number.MAX_SAFE_INTEGER, source: war.id });
  }
  v4Event(state, 'war', `${state.factions[actor].name}声明${WAR_NAMES[type]}目标：${goals.join('、') || '全面征服'}`, war.factions, { warId: war.id, actor, type, goals, reason });
  return war;
}

export function cedeSystem(state: GameState, system: StarSystem, recipient: string | null, warId: string) {
  const previousOwner = system.ownerId;
  const cancelledProjects = structuredClone(system.projects.filter(project => project.ownerId === previousOwner));
  system.ownerId = recipient; delete system.controllerId; delete system.occupationWarId;
  for (const planet of system.planets) if (planet.ownerId) planet.ownerId = recipient;
  system.projects = system.projects.filter(project => project.ownerId !== previousOwner);
  delete system.integrationUntil;
  if (balancedRules(state) && previousOwner !== recipient) {
    delete system.annexation;
    if (recipient && state.wars?.find(war => war.id === warId)?.type === 'total') {
      system.annexation = { ownerId: recipient, warId, startedDay: state.day, controlledDays: 0 };
      v4Event(state, 'war', `${system.name}开始${BALANCE.annexationDays}日吞并整合`, [recipient, previousOwner].filter((id): id is string => !!id), { annexation: system.annexation, production: BALANCE.annexationFactor }, system.id);
    }
  }
  for (const mission of state.missions ?? []) if (mission.systemId === system.id && mission.hostId !== recipient && mission.expiresDay > state.day) mission.expiresDay = state.day;
  if (previousOwner && recipient && previousOwner !== recipient) (state.cessions ??= []).push({ day: state.day, systemId: system.id, from: previousOwner, to: recipient, warId });
  if (previousOwner && recipient && previousOwner !== recipient) {
    annexationProgress(state, recipient, previousOwner, system.id, warId);
    const war = state.wars?.find(item => item.id === warId);
    if (war && ['total', 'claim'].includes(war.type) && war.factions.includes(previousOwner) && war.factions.includes(recipient)) awardAchievement(state, { actor: recipient, target: previousOwner, systemId: system.id, type: 'territory', warId, day: state.day });
  }
  v4Event(state, 'war', `${system.name}正式${recipient ? `转归${state.factions[recipient].name}` : '丧失主权'}`, [previousOwner, recipient].filter((id): id is string => !!id), { warId, previousOwner, ownerId: recipient, cancelledProjects }, system.id);
  observeHolyControl(state, system, warId);
  releaseClaims(state);
}

export interface CaptureIntent { systemId: string; previousOwner: string | null; previousController: string | null; captor: string | null; pair: [string, string] }
export function settleCaptures(state: GameState, captures: CaptureIntent[]) {
  const finalBases = new Map(captures.map(capture => [capture.systemId, structuredClone(state.systems.find(system => system.id === capture.systemId)!.base)]));
  for (const capture of captures) {
    const system = state.systems.find(candidate => candidate.id === capture.systemId)!;
    system.ownerId = capture.previousOwner; system.controllerId = capture.previousController;
    for (const planet of system.planets) if (planet.population) planet.ownerId = capture.previousOwner;
    const owner = system.ownerId;
    const { captor } = capture;
    const combatWar = activeWar(state, ...capture.pair);
    if (revised(state) && combatWar && capture.captor !== capture.previousController && capture.captor) combatWar.hadHostilities = true;
    const legalWar = owner ? captor ? activeWar(state, owner, captor) : combatWar?.factions.includes(owner) ? combatWar : undefined : combatWar;
    if (captor && owner && captor !== owner && !legalWar) {
      delete system.controllerId; delete system.occupationWarId;
      system.base = { hull: BASE.power / 2 };
      v4Event(state, 'war', `${system.name}被解放，归还法理所有者`, capture.pair, capture, system.id);
    } else if (legalWar?.type === 'total') {
      cedeSystem(state, system, captor, legalWar.id);
      system.base = captor ? { hull: BASE.power / 2 } : null;
    } else {
      system.controllerId = captor ?? capture.previousController ?? owner;
      system.occupationWarId = legalWar?.id ?? combatWar?.id;
      system.base = captor ? { hull: BASE.power / 2 } : { hull: 0, disabledUntil: state.day + V4.ruinDays };
      if (controller(system) === owner) { delete system.controllerId; delete system.occupationWarId; }
      v4Event(state, 'war', `${system.name}${captor === owner ? '收复' : captor ? '被临时占领' : '基地停用100日'}，法理归属保留`, capture.pair, { ...capture, warId: legalWar?.id ?? combatWar?.id, controllerId: controller(system) }, system.id);
    }
    for (const project of system.projects.filter(project => project.kind === 'consecrate' && controller(system) !== project.ownerId)) {
      v4Event(state, 'religion', '祝圣因失去实际控制而取消，不退款', [project.ownerId], { projectId: project.id }, system.id);
    }
    system.projects = system.projects.filter(project => project.kind !== 'consecrate' || controller(system) === project.ownerId);
    observeHolyControl(state, system, legalWar?.id ?? combatWar?.id);
  }
  for (const [systemId, base] of finalBases) state.systems.find(system => system.id === systemId)!.base = base;
}

const faithChange = (state: GameState, actor: string, reason: string, amount: number, source: string) => state.factions[actor].faith?.pending.push({ reason, amount, source });

export function settleWar(state: GameState, war: War, reward: boolean, reason: string) {
  if (war.endedDay !== undefined) return;
  const eligible = war.factions.flatMap(actor => war.goals[actor].filter(goal => reward && !goal.invalid && goal.heldDays >= V4.holdDays).map(goal => ({ actor, goal })));
  const remaining = Object.fromEntries(war.factions.map(actor => [actor, state.systems.filter(system => system.ownerId === actor).length]));
  const achieved = new Set<string>();
  for (const { actor, goal } of eligible.sort((first, second) => first.goal.systemId.localeCompare(second.goal.systemId) || first.actor.localeCompare(second.actor))) {
    const target = war.factions.find(id => id !== actor)!;
    const system = state.systems.find(candidate => candidate.id === goal.systemId)!;
    if (!goalValid(state, actor, target, goal) || controller(system) !== actor) continue;
    if (goal.type === 'claim') {
      if (remaining[target] <= 1 || state.factions[target].homeSystemId === system.id) continue;
      remaining[target]--; remaining[actor]++;
      cedeSystem(state, system, actor, war.id);
    } else if (goal.type === 'limited') {
      if (system.base) system.base.disabledUntil = state.day + V4.disabledDays;
      const compensation = Math.min(state.factions[target].resources.minerals, units(V4.reparations));
      state.factions[target].resources.minerals -= compensation; state.factions[actor].resources.minerals += compensation;
      v4Event(state, 'war', `军事赔偿${compensation / 1000}矿物，目标基地停用300日`, war.factions, { warId: war.id, compensation, actor, target }, system.id);
    } else if (goal.type === 'missionary') {
      (state.missions ??= []).push({ id: `${war.id}-${actor}-${system.id}`, warId: war.id, religionId: actor, hostId: target, systemId: system.id, startsDay: state.day, expiresDay: state.day + V4.missionDays });
      for (const planet of system.planets.filter(planet => planet.population)) {
        planet.influence ??= {};
        addInfluence(planet.influence, actor, Math.max(0, V4.missionInitial - (planet.influence[actor] ?? 0)));
      }
      faithChange(state, actor, '传教目标达成', -V4.missionVictory, war.id);
    } else if (goal.type==='humanitarian') {
      const extraction=state.factions[target].extraction;
      if(emergencyRules(state)&&extraction?.id===war.humanitarianReasons?.[actor]&&!extractingAt(extraction,state.day))continue;
      if(!responsible(state)||liveReform(state,target)&&!(emergencyRules(state)&&state.factions[target].extraction?.id===war.humanitarianReasons?.[actor]&&state.factions[target].extraction?.stoppedDay===undefined))continue;
      enforceReform(state,actor,target,war.humanitarianReasons?.[actor]??'',war.id,goal.systemId);
    } else {
      for (const mission of state.missions ?? []) if (mission.systemId === system.id && mission.religionId === target) mission.expiresDay = Math.min(mission.expiresDay, state.day);
      for (const planet of system.planets) if (planet.influence) delete planet.influence[target];
      system.missionProtectionUntil = state.day + V4.protectionDays;
    }
    goal.achieved = true; achieved.add(actor);
    if (goal.type !== 'claim') awardAchievement(state, { actor, target, systemId: system.id, type: goal.type, warId: war.id, day: state.day });
  }
  for (const system of state.systems) if (system.occupationWarId === war.id) {
    delete system.controllerId; delete system.occupationWarId;
    observeHolyControl(state, system, war.id);
    v4Event(state, 'war', `${system.name}归还法理所有者`, war.factions, { warId: war.id, ownerId: system.ownerId }, system.id);
  }
  if (war.type === 'total') for (const actor of war.factions) if ((state.cessions ?? []).some(cession => cession.warId === war.id && cession.to === actor && state.systems.find(system => system.id === cession.systemId)?.ownerId === actor)) achieved.add(actor);
  for (const actor of war.factions) {
    if (achieved.has(war.factions.find(id => id !== actor)!)) faithChange(state, actor, '对手兑现战争目标', V4.warFailure, war.id);
    if (war.attackers.includes(actor) && !achieved.has(actor)) faithChange(state, actor, '主动战争未达成目标', V4.warFailure, war.id);
  }
  war.endedDay = state.day; war.outcome = reason;
  if(emergencyRules(state))for(const target of war.factions){const e=state.factions[target].extraction;if(e?.stoppedDay!==undefined)settleExtractionWars(state,target,e.id,war.id);}
  onWarResponsibility(state,war,achieved);
  recordRivalry(state, war);
  const relation = relationship(state, ...war.factions)!;
  relation.status = 'peace'; relation.confirmed = [...war.factions]; relation.pactUntil = state.day + RULES.nonAggressionDays; relation.offers = {}; delete relation.warId;
  for (const grievance of state.grievances ?? []) if (grievance.kind === 'attacked' && grievance.source === war.id) { grievance.active = false; grievance.expiresDay = state.day + V4.attackedGrievanceDays; }
  for (const fleet of state.fleets) if (war.factions.includes(fleet.ownerId) && fleet.order) {
    const enemy = war.factions.find(id => id !== fleet.ownerId)!;
    const destination = state.systems.find(system => system.id === fleet.order!.systemId);
    const targetFleet = state.fleets.find(candidate => candidate.id === fleet.order!.targetFleetId);
    if (targetFleet?.ownerId === enemy || destination && controller(destination) === enemy) fleet.order = null;
  }
  v4Event(state, 'war', `${WAR_NAMES[war.type]}结束：${reason}，签订三年互不侵犯`, war.factions, { war: structuredClone(war), achieved: [...achieved], pactUntil: relation.pactUntil });
}

export function addInfluence(influence: Record<string, number>, religion: string, amount: number) {
  const previous = influence[religion] ?? 0;
  influence[religion] = roundValue(Math.max(0, Math.min(100, previous + amount)));
  const others = Object.keys(influence).filter(id => id !== religion).sort();
  const otherTotal = others.reduce((sum, id) => sum + influence[id], 0);
  let excess = Math.max(0, otherTotal + influence[religion] - 100);
  const initialExcess = excess;
  for (const [index, id] of others.entries()) {
    const reduction = Math.min(influence[id], index === others.length - 1 ? excess : roundValue(initialExcess * influence[id] / otherTotal));
    influence[id] = roundValue(influence[id] - reduction); excess = roundValue(excess - reduction);
  }
}

export function goalValid(state: GameState, actor: string, target: string, goal: WarGoal) {
  const system = state.systems.find(candidate => candidate.id === goal.systemId);
  return !!system && system.ownerId === (goal.type === 'ideological' ? actor : target);
}

export function updateWars(state: GameState) {
  releaseClaims(state);
  state.claims = (state.claims ?? []).filter(claim => claim.expiresDay > state.day);
  for (const war of (state.wars ?? []).filter(war => war.endedDay === undefined).sort((first, second) => first.id.localeCompare(second.id))) {
    if(war.endedDay!==undefined)continue;
    if(emergencyRules(state)&&war.factions.some(target=>{const e=state.factions[target].extraction;return e&&(e.stoppedDay!==undefined||state.day>=e.expiresDay)&&Object.values(war.humanitarianReasons??{}).includes(e.id);})){settleWar(state,war,false,'征收已停止或到期，归还占领，不重复授分');continue;}
    for (const actor of war.factions) {
      const target = war.factions.find(id => id !== actor)!;
      for (const goal of war.goals[actor]) {
        if (!goalValid(state, actor, target, goal)) goal.invalid = true;
        const system = state.systems.find(candidate => candidate.id === goal.systemId);
        const held = !goal.invalid && system && controller(system) === actor && system.base && system.base.hull > 0 && (goal.type !== 'ideological' || !state.fleets.some(fleet => fleet.ownerId === target && fleet.systemId === system.id));
        if (held) { goal.heldSince ??= state.day; goal.heldDays = state.day - goal.heldSince; }
        else { delete goal.heldSince; goal.heldDays = 0; }
      }
      if (war.type !== 'total') {
        const owned = state.systems.filter(system => system.ownerId === actor);
        const lost = owned.filter(system => controller(system) === target).length;
        war.fatigue[actor] = roundValue(Math.min(100, war.fatigue[actor] + (V4.fatigueTime + V4.fatigueOccupation * lost / Math.max(1, owned.length)) * Math.min(RULES.tickDays, state.day - war.startedDay) / 100));
      }
    }
    if (war.type === 'total') continue;
    const goals = Object.values(war.goals).flat();
    if (goals.length && goals.every(goal => goal.invalid)) settleWar(state, war, false, '全部目标失效');
    else if (war.factions.some(id => war.fatigue[id] >= 100) || state.day - war.startedDay >= (war.type === 'contact' ? V4.contactDays : V4.warDays)) settleWar(state, war, true, '战争疲劳或期限触发强制结算');
  }
  updateGrievances(state);
}

export function updateGrievances(state: GameState) {
  state.grievances ??= [];
  const active = new Set<string>();
  const set = (actor: string, target: string, kind: 'home' | 'territory' | 'holy', source: string) => {
    if (actor === target || state.factions[target]?.eliminatedDay !== undefined) return;
    const id = `${actor}:${target}:${kind}`; active.add(id);
    let grievance = state.grievances!.find(candidate => candidate.id === id);
    if (!grievance) { grievance = { id, actor, target, kind, active: true, expiresDay: Number.MAX_SAFE_INTEGER, source }; state.grievances!.push(grievance); v4Event(state, 'war', `${state.factions[actor].name}获得总体战理由：${kind}`, [actor, target], grievance); }
    grievance.active = true; grievance.expiresDay = Number.MAX_SAFE_INTEGER;
  };
  for (const actor of factionIds(state)) {
    const faction = state.factions[actor];
    const home = state.systems.find(system => system.id === faction.homeSystemId);
    if (home && controller(home) && controller(home) !== actor) set(actor, controller(home)!, 'home', home.id);
    for (const target of factionIds(state).filter(id => id !== actor)) {
      const lost = new Set((state.cessions ?? []).filter(cession => cession.from === actor && cession.to === target && state.systems.find(system => system.id === cession.systemId)?.ownerId === target).map(cession => cession.systemId));
      if (lost.size >= 2) set(actor, target, 'territory', [...lost].sort().join(','));
    }
    const main = faction.faith?.sites.find(site => site.main && site.consecratedDay !== undefined);
    if (main?.lostSince !== undefined && state.day - main.lostSince >= 300) {
      const system = state.systems.find(system => system.planets.some(planet => planet.id === main.planetId));
      if (system && controller(system)) set(actor, controller(system)!, 'holy', main.planetId);
    }
  }
  for (const grievance of state.grievances) if (grievance.kind !== 'attacked' && grievance.active && !active.has(grievance.id)) { grievance.active = false; grievance.expiresDay = state.day + V4.grievanceDays; }
}

export function accountBattleLosses(state: GameState, events: LocalEvent[], opening: Record<string, number>) {
  const window = Math.floor((state.day - RULES.tickDays) / 100);
  for (const event of events.filter(event => event.type === 'battle').sort((first, second) => (first.systemId ?? '').localeCompare(second.systemId ?? '') || (first.details as { order: number }).order - (second.details as { order: number }).order)) {
    const details = event.details as { pair: [string, string]; participants: { id: string; ownerId: string; baseHull?: number; ships: { id: string; type: keyof typeof SHIPS; hull: number }[] }[]; remaining: { id: string; baseHull?: number; ships: { id: string; hull: number }[] }[] };
    const war = activeWar(state, ...details.pair);
    if (revised(state) && war && details.participants.some(unit => unit.baseHull !== undefined && unit.baseHull > (details.remaining.find(item => item.id === unit.id)?.baseHull ?? 0))) war.hadHostilities = true;
    for (const actor of details.pair) {
      let lost = 0;
      for (const unit of details.participants.filter(unit => unit.ownerId === actor)) for (const ship of unit.ships) {
        const remaining = details.remaining.find(candidate => candidate.id === unit.id)?.ships.find(candidate => candidate.id === ship.id)?.hull ?? 0;
        lost += Math.max(0, ship.hull - remaining) * SHIPS[ship.type].minerals / SHIPS[ship.type].power;
      }
      if (revised(state) && war && lost > 0) war.hadHostilities = true;
      const faith = state.factions[actor].faith;
      let fatigue = 0; let crisis = 0;
      if (war) {
        if (war.lossWindow !== window) { war.lossWindow = window; war.lossUsed = Object.fromEntries(war.factions.map(id => [id, 0])); }
        fatigue = Math.max(0, Math.min(V4.fatigueLossCap - war.lossUsed[actor], V4.fatigueLoss * lost / war.openingValue[actor]));
        war.lossUsed[actor] += fatigue; war.fatigue[actor] = roundValue(Math.min(100, war.fatigue[actor] + fatigue));
      }
      if (faith) {
        if (faith.lossWindow !== window) { faith.lossWindow = window; faith.lossUsed = 0; }
        crisis = Math.max(0, Math.min(V4.crisisLossCap - faith.lossUsed, V4.crisisLoss * lost / Math.max(V4.militaryFloor, opening[actor])));
        faith.lossUsed += crisis; faith.pending.push({ reason: '战斗船体损失', amount: crisis, source: war?.id });
      }
      if (lost) v4Event(state, 'war', `${state.factions[actor].name}战损折算：疲劳+${fatigue.toFixed(2)}，危机+${crisis.toFixed(2)}`, [actor], { actor, warId: war?.id, lostValue: lost, openingWarValue: war?.openingValue[actor], openingTickValue: opening[actor], fatigue, crisis, fatigueCapUsed: war?.lossUsed[actor], crisisCapUsed: faith?.lossUsed }, event.systemId);
    }
  }
}

export function restoreBases(state: GameState) {
  for (const system of state.systems) if (system.base?.disabledUntil && system.base.disabledUntil <= state.day) {
    if (!system.base.hull) system.base.hull = BASE.power / 2;
    delete system.base.disabledUntil;
    v4Event(state, 'war', `${system.name}基地恢复运行`, [system.ownerId, controller(system)].filter((id): id is string => !!id), {}, system.id);
  }
}
