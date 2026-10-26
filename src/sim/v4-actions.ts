import { governed } from '../shared/governance.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { responsible, newResponsibility, responsibilityView } from '../shared/responsibility.js';
import { initializeSocial, rescueReasons } from './social.js';
import { accessiblePath } from './diplomacy.js';
import { modern, route } from '../shared/civilization.js';
import { religionEligibility } from '../shared/religion-options.js';
import { decisionComparison } from './options.js';
import { balancedRules, civilizationScore, holyCooperation } from '../shared/balance.js';
import { borders, preparationRule, conquestFor, endConquest, ESCALATION, escalationView, revised, warReasons } from '../shared/escalation.js';
import { z } from 'zod';
import { RULES, units } from '../shared/rules.js';
import { relationship } from '../shared/diplomacy.js';
import { V4, activeWar, controller, occupied, v4Event, warView } from '../shared/v4.js';
import type { WarType } from '../shared/v4.js';
import type { Action, GameState, StarSystem } from '../shared/types.js';
import { declareWar, settleWar } from './wars.js';

export { V4_SCHEMAS, V4_DESCRIPTIONS } from '../shared/war-tools.js';
const ensure: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
function pay(state: GameState, actor: string, minerals: number, food = 0) {
  const resources = state.factions[actor].resources;
  ensure(resources.minerals >= units(minerals) && resources.food >= units(food), '可用资源不足，包含已预留资源');
  resources.minerals -= units(minerals); resources.food -= units(food);
}

export function applyV4Action(state: GameState, actor: string, action: Action, ticket: string, committed: boolean, validateOnly = false): unknown {
  const { args, type } = action;
  const faction = state.factions[actor];
  const find = (id: string) => { const system = state.systems.find(candidate => candidate.id === id); ensure(system, '星系不存在'); return system; };
  const known = (system: StarSystem) => {
    if (committed || controller(system) === actor) return system;
    if (state.fleets.some(fleet => fleet.ownerId === actor && fleet.systemId === system.id)) return { ...system, planets: faction.surveyed.includes(system.id) ? system.planets : [] };
    const intel = faction.intel[system.id];
    const military = faction.militaryIntel?.[system.id];
    ensure(intel || military, '缺少目标情报');
    const snapshot = intel?.system ?? { ...system, ownerId: null, base: null, planets: [], projects: [], missionProtectionUntil: undefined, integrationUntil: undefined };
    if(governed(state))return {...snapshot,...(military&&military.day>=(intel?.day??-1)?{ownerId:military.ownerId,controllerId:controller(military),base:military.base}:{}),planets:faction.surveyed.includes(system.id)?snapshot.planets:[]};
    return { ...snapshot, ownerId: military?.ownerId ?? snapshot.ownerId, controllerId: military ? controller(military) : controller(snapshot), base: military ? military.base : snapshot.base, planets: faction.surveyed.includes(system.id) ? snapshot.planets : [] };
  };
  const bordering = (system: StarSystem) => system.neighbors.some(id => find(id).ownerId === actor);
  if (type === 'prepare_conquest' || type === 'cancel_conquest') {
    ensure(revised(state), '此工具需要4.1规则分支');
    const preparation = conquestFor(state, actor);
    if (type === 'cancel_conquest') {
      ensure(preparation, '没有可撤回的征服准备');
      endConquest(state, preparation, '主动撤回，不退款'); return preparation;
    }
    const target = args.factionId as string;
    ensure(target !== actor && state.factions[target] && state.factions[target].eliminatedDay === undefined, '目标不是其他存活势力');
    const cost = preparationRule(state,actor);
    ensure(!modern(state) || route(state,actor)!=='utopia', '乌托邦禁止主动征服准备；仍允许其他合法战争');
    ensure(!preparation && relationship(state, actor, target)?.status === 'peace', '须双方和平且本方没有进行中的征服准备');
    ensure(borders(state, actor, target, committed), '需要情报确认的法理接壤；实际结算复核');
    ensure(faction.unity >= cost.unity * 100, `凝聚力不足${cost.unity}`);
    ensure(faction.resources.minerals >= units(cost.minerals) && faction.resources.food >= units(cost.food), '可用资源不足，包含已预留资源');
    if (validateOnly) return { valid: true };
    pay(state, actor, cost.minerals, cost.food);
    faction.unity -= cost.unity * 100;
    const item = { id: 'conquest-' + ticket, actor, target, reason: args.reason as string, startedDay: state.day, readyDay: state.day + cost.days, freePeaceDays: 0 };
    (state.conquests ??= []).push(item);
    v4Event(state, 'war', faction.name + '公开准备征服' + state.factions[target].name, [actor, target], { ...item, costs: { minerals: cost.minerals, food: cost.food, unity: cost.unity } });
    return item;
  }
  if (type === 'get_options') return decisionComparison(state, actor);
  if (type === 'get_wars') return { ...(governed(state)?{settlementPreview:(state.wars??[]).filter(w=>w.factions.includes(actor)&&w.endedDay===undefined).map(w=>settlementPreview(state,actor,w))}:{}), ...(responsible(state)?{responsibilities:responsibilityView(state,actor),rescueReasons:rescueReasons(state,actor)}:{}), ...(balancedRules(state) ? { comparison: decisionComparison(state, actor).wars } : {}), escalation: escalationView(state, actor), wars: (state.wars ?? []).filter(war => war.factions.includes(actor)).map(war => warView(war, actor)), claims: (state.claims ?? []).filter(claim => claim.factionId === actor), grievances: (state.grievances ?? []).filter(grievance => grievance.actor === actor && (grievance.active || grievance.expiresDay > state.day)) };
  if (type === 'get_faith') return { ...(responsible(state)?{responsibilities:responsibilityView(state,actor)}:{}), ...(balancedRules(state) ? { stableFaith: faction.stableFaith ?? null, civilization: civilizationScore(state, actor), holyCooperation: holyCooperation(state, actor), comparison: decisionComparison(state, actor).religion } : {}), faith: faction.faith ?? null, beacon: faction.beacon ?? null, candidates: state.systems.filter(system => faction.surveyed.includes(system.id)).flatMap(system => system.planets.filter(planet => planet.holyCandidate).map(planet => ({ systemId: system.id, planetId: planet.id }))) };
  if (type === 'create_claim') {
    const system = known(find(args.systemId as string));
    ensure(faction.surveyed.includes(system.id) && bordering(system), '宣称需要已探索的邻接星系');
    ensure(system.ownerId && system.ownerId !== actor && state.factions[system.ownerId].homeSystemId !== system.id, '只能宣称敌方非母星星系');
    const claims = (state.claims ??= []).filter(claim => claim.factionId === actor && claim.expiresDay > state.day);
    ensure(claims.length < V4.maxClaims && !claims.some(claim => claim.systemId === system.id), '宣称已存在或达到两个上限');
    ensure(faction.resources.minerals>=units(V4.claimCost),'可用矿物不足100，包含已预留资源');
    if (validateOnly) return { valid: true };
    pay(state, actor, V4.claimCost);
    const claim = { factionId: actor, targetId: system.ownerId, systemId: system.id, createdRound: state.round, expiresDay: state.day + V4.claimDays };
    state.claims.push(claim); v4Event(state, 'war', `${faction.name}宣称${system.name}`, [actor, system.ownerId], claim, system.id);
    return claim;
  }
  if (type === 'declare_war') {
    const target = args.factionId as string;
    ensure(target !== actor && state.factions[target]?.eliminatedDay === undefined, '目标不是其他存活势力');
    const relation = relationship(state, actor, target);
    const existing = activeWar(state, actor, target);
    ensure(!relation?.pactUntil || relation.pactUntil <= state.day, 'PACT_ACTIVE [factionId] 互不侵犯尚未到期，请等待条约结束');
    ensure(relation && (relation.status === 'peace' || committed && existing?.startedDay === state.day && existing.startedRound === state.round && !existing.attackers.includes(actor)) && (!relation.pactUntil || relation.pactUntil <= state.day), '须已建立和平且没有有效互不侵犯条约；战争中不可改目标');
    const warType = args.warType as Exclude<WarType, 'contact'>;
    const goals = args.systemIds as string[];
    ensure(new Set(goals).size === goals.length, '战争目标不能重复');
    if (warType === 'total') {
      ensure(!goals.length, 'TOTAL_WAR_TARGETS_MUST_BE_EMPTY [systemIds] 总体战必须填写 []，进攻目的地请放在后续 move_fleet；请重新提交完整计划');
      ensure(warReasons(state, actor, committed).some(grievance => grievance.id === args.grievanceId && grievance.target === target && grievance.usable), 'TOTAL_WAR_REASON_INVALID [grievanceId] 请使用本方针对该国且当前可用的重大理由 ID');
    } else {
      ensure((warType==='humanitarian' ? responsible(state)&&rescueReasons(state,actor).some(r=>r.target===target&&r.id===args.grievanceId&&r.usableDay<=state.day) : args.grievanceId === null) && goals.length >= 1 && goals.length <= (warType === 'claim' ? 2 : 1), '战争目标数量或理由参数不正确');
      for (const id of goals) {
        const system = known(find(id));
        ensure(faction.surveyed.includes(id) || faction.intel[id] || faction.militaryIntel?.[id] || controller(system) === actor, '目标必须来自本方已获得的情报');
        if (warType === 'ideological') {
          const influence = system.planets.some(planet => (planet.influence?.[target] ?? 0) >= 20);
          ensure(system.ownerId === actor && system.planets.some(planet => planet.population) && (influence || (state.missions ?? []).some(mission => mission.systemId === id && mission.hostId === actor && mission.religionId === target && mission.expiresDay > state.day)), '没有外国传教权或达到20的外国影响');
        } else {
          ensure(system.ownerId === target && system.base && bordering(system), '目标须为与己方领土相邻的敌方基地');
          if (warType === 'claim') {
            ensure(system.id !== state.factions[target].homeSystemId, '非总体战不能割让初始母星');
            ensure((state.claims ?? []).some(claim => claim.factionId === actor && claim.targetId === target && claim.systemId === id && claim.createdRound < state.round && claim.expiresDay > state.day), '须有前一回合创建且未到期的宣称');
          }
          if (responsible(state) && ['missionary','humanitarian'].includes(warType)) ensure(state.systems.filter(s=>s.ownerId===actor&&controller(s)===actor).some(s=>accessiblePath(state,actor,s.id,id,true,target)), '没有本方已知且符合中间通行规则的目标路径');
          if (warType==='humanitarian') ensure(responsible(state)&&route(state,actor)==='utopia'&&system.planets.some(p=>p.population), '救援战须乌托邦和已知敌方边境殖民目标');
          if (warType === 'missionary') ensure(faction.faith && system.planets.some(planet => planet.population) && (system.missionProtectionUntil ?? 0) <= state.day, '传教战需要国教、敌方殖民地且目标不处于传教保护期');
        }
      }
      if (warType === 'claim' && committed) ensure(state.systems.filter(system => system.ownerId === target).length > goals.length, '割让不能消灭对方最后一个法理星系');
    }
    if (validateOnly) return { valid: true };
    const war = declareWar(state, actor, target, warType, goals, args.reason as string);
    if(warType==='humanitarian') (war.humanitarianReasons??={})[actor]=args.grievanceId as string;
    const preparation = conquestFor(state, actor);
    if (preparation?.target === target) endConquest(state, preparation, warType === 'total' && args.grievanceId === preparation.id ? '资格用于总体战宣战' : '双方开始其他战争');
    return committed ? war : warView(war, actor);
  }
  if (type === 'enforce_peace') {
    const war = activeWar(state, actor, args.factionId as string);
    ensure(war && war.type !== 'total' && war.goals[actor].length && war.goals[actor].every(goal => !goal.invalid && goal.heldDays >= V4.holdDays), '全部有效战争目标须连续控制200日');
    settleWar(state, war, true, `${faction.name}要求兑现战争目标`); return { warId: war.id, endedDay: state.day };
  }
  if (type === 'establish_religion' || type === 'consecrate') {
    const system = state.systems.find(system => system.planets.some(planet => planet.id === args.planetId));
    ensure(system && faction.surveyed.includes(system.id), '须完成探索后发现圣地候选');
    const planet = system.planets.find(planet => planet.id === args.planetId)!;
    ensure(planet.holyCandidate || responsible(state)&&type==='consecrate', '该行星不是发现的圣地候选');
    if (type === 'establish_religion') {
      const blocker = religionEligibility(state, actor, planet.id, committed);
      ensure(!blocker, blocker ?? '立教条件不满足');
      if (validateOnly) return { valid: true };
      if(responsible(state)){initializeSocial(state);state.social!.founders.push({planetId:planet.id,actor,day:state.day});faction.responsibility=newResponsibility(state.day);}
      faction.faith = { name: args.name as string, doctrine: args.doctrine as string, establishedDay: state.day, crisis: 0, sites: [{ planetId: planet.id, main: true, lossKeys: [], recoveryKeys: [] }], lossWindow: Math.floor(state.day / 100), lossUsed: 0, pending: [], triggers: {} };
      if (modern(state)) { faction.civilization = { choice: 'theocracy', establishedDay: state.day, historyBeacon: faction.civilization?.historyBeacon }; faction.welfare = { choice: 'church', selectedDay: state.day, firstChoice: false, highestSince: null, history: [] }; }
      if (faction.beacon) faction.beacon.streak = 0;
      const audience = Object.values(state.relations).filter(relation => relation.factions.includes(actor) && relation.status !== 'unknown').flatMap(relation => relation.factions);
      v4Event(state, 'religion', `${faction.name}永久确立国教「${faction.faith.name}」，永远放弃乌托邦`, [actor, ...audience], { actor, name: faction.faith.name, doctrine: faction.faith.doctrine, mainSite: planet.id, permanent: true }, system.id);
      return { established: true, permanent: true, utopiaForbidden: true };
    }
    ensure(faction.faith && system.ownerId === actor && controller(system) === actor && planet.ownerId === actor && planet.population > 0, '祝圣需要国教与己方实际控制的殖民地');
    const site = faction.faith.sites.find(site => site.planetId === planet.id);
    ensure(site?.consecratedDay === undefined && !system.projects.some(project => project.kind === 'consecrate' && project.planetId === planet.id && project.ownerId === actor), '已经祝圣或已在祝圣中');
    const secondaryPending = state.systems.flatMap(system => system.projects).filter(project => project.kind === 'consecrate' && project.ownerId === actor && !faction.faith!.sites.some(site => site.main && site.planetId === project.planetId)).length;
    ensure(site?.main || faction.faith.sites.filter(site => !site.main).length + secondaryPending < V4.secondarySites, '最多两个附属圣地（含施工预留）');
    pay(state, actor, V4.consecrateMinerals, V4.consecrateFood);
    system.projects.push({ id: ticket, kind: 'consecrate', ownerId: actor, planetId: planet.id, structureType: null, shipType: null, progress: 0, requiredDays: V4.consecrateDays, cost: { energy: 0, minerals: units(V4.consecrateMinerals), food: units(V4.consecrateFood) }, createdDay: state.day });
    return { projectId: ticket, requiredDays: V4.consecrateDays };
  }
  if (type === 'integrate_thought') {
    const system = find(args.systemId as string);
    ensure(system.ownerId === actor && !occupied(system) && system.planets.some(planet => planet.population) && (system.integrationUntil ?? 0) <= state.day, '需要己方实际控制的殖民星系，思想整合不能叠加');
    pay(state, actor, V4.integrationMinerals, V4.integrationFood);
    system.integrationUntil = state.day + V4.integrationDays;
    v4Event(state, 'religion', `${system.name}开始720日思想整合`, [actor], { until: system.integrationUntil }, system.id);
    return { endsDay: system.integrationUntil };
  }
  if (type === 'respond_dispute') {
    const faith = faction.faith;
    ensure(faith?.dispute && (!faith.response || faith.response.cooldownUntil <= state.day), '没有待回应争端，或处于720日回应冷却期');
    const responseType = args.response as 'reconcile' | 'reform' | 'zeal';
    const response: NonNullable<typeof faith.response> = { type: responseType, startsDay: state.day, effectUntil: state.day + V4.responseDays, cooldownUntil: state.day + V4.responseCooldown };
    if (responseType === 'reconcile') pay(state, actor, V4.reconciliationMinerals, V4.reconciliationFood);
    if (responseType === 'zeal') {
      const main = faith.sites.find(site => site.main && site.lostSince !== undefined);
      if (main && args.warId === null && args.systemId === null) response.vow = { planetId: main.planetId, deadline: state.day + V4.responseCooldown, resolved: false };
      else {
        const war = state.wars?.find(war => war.id === args.warId && war.endedDay === undefined && war.attackers.includes(actor));
        ensure(war && war.goals[actor].some(goal => goal.systemId === args.systemId && !goal.invalid && goal.type !== 'ideological'), '坚持圣战须绑定失守主圣地或当前已声明的进攻目标');
        response.vow = { warId: war.id, systemId: args.systemId as string, deadline: state.day + V4.responseCooldown, resolved: false };
      }
    }
    v4Event(state, 'religion', `${faction.name}回应教义争端：${responseType}`, [actor], { dispute: faith.dispute, response });
    delete faith.dispute; faith.response = response;
    return response;
  }
  throw new Error('未知V4命令');
}
