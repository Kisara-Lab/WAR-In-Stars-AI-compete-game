import { governed } from '../shared/governance.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { sensorCoverage } from '../shared/civil.js';
import { RULES, factionIds } from '../shared/rules.js';
import type { Action, GameState, Relation } from '../shared/types.js';
import { canEnter, relationKey, relationship } from '../shared/diplomacy.js';
import { distance, shortestPath } from './math.js';
import { V4, activeWar, controller, operational, v4Event } from '../shared/v4.js';
import { createWar, settleWar } from './wars.js';
import { assignHolyCandidates, discoverHoly } from './religion.js';

export const DIPLOMATIC_ACTIONS = ['confirm_contact', 'declare_war', 'enforce_peace', 'propose_peace', 'accept_peace', 'reject_peace', 'withdraw_peace', 'open_borders', 'close_borders'];

export function createRelations(ids: string[], legacy = false): Record<string, Relation> {
  const result: Record<string, Relation> = {};
  for (const [index, first] of [...ids].sort().entries()) for (const second of [...ids].sort().slice(index + 1)) {
    result[relationKey(first, second)] = { factions: [first, second], status: legacy ? 'war' : 'unknown', contactDay: legacy ? 0 : null, confirmed: legacy ? [first, second] : [], warDay: legacy ? 0 : null, pactUntil: null, access: { [first]: false, [second]: false }, offers: {} };
  }
  return result;
}

export function diplomacyEvent(state: GameState, text: string, audience: string[], systemId: string | null = null) {
  const sequence = Math.max(state.events.length, ...state.events.filter(event => event.day === state.day && event.id.includes('-diplomacy-')).map(event => Number(event.id.split('-diplomacy-')[1]) + 1));
  state.events.push({ id: `${state.day}-diplomacy-${sequence}`, round: state.round + 1, day: state.day, type: 'diplomacy', text, systemId, audience: [...audience].sort() });
}

function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function applyDiplomacy(state: GameState, actor: string, action: Action) {
  const target = action.args.factionId as string;
  ensure(target !== actor && state.factions[target] && state.factions[target].eliminatedDay === undefined, '目标必须是另一个存活势力');
  const relation = relationship(state, actor, target);
  ensure(relation && relation.status !== 'unknown', '尚未实际接触该势力');
  const pairName = `${state.factions[actor].name} → ${state.factions[target].name}`;
  const offer = relation.offers[target];
  const warBefore = activeWar(state,actor,target);
  const preview = governed(state) && warBefore && ['accept_peace','propose_peace'].includes(action.type) ? settlementPreview(state,actor,warBefore) : null;
  switch (action.type) {
    case 'confirm_contact':
      ensure(relation.status === 'contact' && !relation.confirmed.includes(actor), '当前没有待确认的接触事件');
      relation.confirmed.push(actor); relation.confirmed.sort();
      if (relation.confirmed.length === 2) { relation.status = 'peace'; relation.access = Object.fromEntries(relation.factions.map(id => [id, false])); }
      break;
    case 'declare_war':
      ensure(state.version < 4, 'V4宣战必须通过包含战争类型、目标和理由的工具校验');
      ensure(relation.status === 'peace' && (!relation.pactUntil || relation.pactUntil <= state.day), '仅和平且无有效互不侵犯条约时可宣战');
      relation.status = 'war'; relation.warDay = state.day; relation.offers = {};
      break;
    case 'propose_peace':
      ensure(relation.status === 'war' && !relation.offers[actor], '仅战争中可提出尚不存在的停战提议');
      relation.offers[actor] = { createdRound: state.round, expiresDay: state.day + RULES.peaceOfferDays };
      break;
    case 'accept_peace':
    case 'reject_peace':
      ensure(relation.status === 'war' && offer && offer.createdRound < state.round && offer.expiresDay > state.day, '没有上一轮收到的有效停战提议');
      delete relation.offers[target];
      if (action.type === 'accept_peace') {
        const war = activeWar(state, actor, target);
        if (war) settleWar(state, war, false, '双方接受无条件停战');
        relation.status = 'peace'; relation.confirmed = [...relation.factions]; relation.pactUntil = state.day + RULES.nonAggressionDays; relation.offers = {};
      }
      break;
    case 'withdraw_peace':
      ensure(relation.offers[actor], '没有己方停战提议可撤回');
      delete relation.offers[actor];
      break;
    case 'open_borders':
    case 'close_borders':
      ensure(relation.confirmed.length === 2, '完成正式接触后才可调整通行权');
      relation.access[actor] = action.type === 'open_borders';
      break;
    default: throw new Error('未知外交命令');
  }
  const names: Record<string, string> = { confirm_contact: relation.status === 'peace' ? '完成接触，建立和平关系' : '确认接触，等待对方确认', declare_war: '正式宣战', propose_peace: '提出停战，有效300日', accept_peace: '接受停战，签订三年互不侵犯条约', reject_peace: '拒绝停战', withdraw_peace: '撤回停战提议', open_borders: '单向开放边境', close_borders: '关闭边境' };
  diplomacyEvent(state, `${pairName}：${names[action.type]}`, relation.factions);
  return preview ? {...structuredClone(relation), settlementPreview:preview} : structuredClone(relation);
}

export function updateContacts(state: GameState) {
  const reveal = (first: string, second: string, systemId: string) => {
    if (first === second) return;
    const relation = relationship(state, first, second);
    if (!relation || relation.status !== 'unknown') return;
    relation.status = 'contact'; relation.contactDay = state.day;
    diplomacyEvent(state, `${state.factions[first].name}与${state.factions[second].name}首次接触，双方确认前允许直接交战`, [first, second], systemId);
  };
  for (const system of state.systems) {
    const present = new Set(state.fleets.filter(fleet => fleet.systemId === system.id || fleet.departedDay === state.day && fleet.transit?.from === system.id).map(fleet => fleet.ownerId));
    if (system.base && controller(system)) present.add(controller(system)!);
    const ids = [...present].sort();
    for (const [index, first] of ids.entries()) for (const second of ids.slice(index + 1)) {
      reveal(first, second, system.id);
    }
  }
  for (const actor of factionIds(state)) {
    const coverage = sensorCoverage(state, actor);
    for (const system of state.systems.filter(candidate => coverage.has(candidate.id))) {
      if (system.base && controller(system)) reveal(actor, controller(system)!, system.id);
      for (const fleet of state.fleets.filter(candidate => candidate.systemId === system.id || candidate.transit && coverage.has(candidate.transit.from) && coverage.has(candidate.transit.to))) reveal(actor, fleet.ownerId, system.id);
    }
  }
  for (const actor of factionIds(state)) for (const intel of Object.values(state.factions[actor].intel)) {
    if (intel.day === state.day && intel.system.base && intel.system.ownerId) reveal(actor, intel.system.ownerId, intel.system.id);
  }
}

export function markContactWars(state: GameState, pairs: string[]) {
  for (const key of [...new Set(pairs)].sort()) {
    const relation = state.relations[key];
    if (relation.status !== 'contact') continue;
    if (state.version >= 4) createWar(state, relation.factions, 'contact');
    relation.status = 'war'; relation.warDay = state.day;
    relation.confirmed = [...relation.factions];
    diplomacyEvent(state, `${relation.factions.map(id => state.factions[id].name).join('与')}：首次接触冲突，转入战争`, relation.factions);
  }
}

export function accessiblePath(state: GameState, factionId: string, from: string, to: string, knownOnly = false, withdrawingHost?: string) {
  const visible = new Set([...state.systems.filter(system => controller(system) === factionId).map(system => system.id), ...state.fleets.filter(fleet => fleet.ownerId === factionId && fleet.systemId).map(fleet => fleet.systemId!)]);
  const allowed = new Set(state.systems.filter(system => {
    const intel = state.factions[factionId].intel[system.id]?.system;
    const owner = knownOnly && !visible.has(system.id) ? (intel ? controller(intel) : null) : controller(system);
    return system.id === from || owner === withdrawingHost || canEnter(state, factionId, owner);
  }).map(system => system.id));
  return shortestPath(state.systems.filter(system => allowed.has(system.id)).map(system => ({ ...system, neighbors: system.neighbors.filter(id => allowed.has(id)) })), from, to);
}

export function updateDiplomacy(state: GameState) {
  for (const relation of Object.values(state.relations)) {
    if (relation.pactUntil !== null && relation.pactUntil <= state.day) {
      relation.pactUntil = null;
      diplomacyEvent(state, `${relation.factions.map(id => state.factions[id].name).join('与')}：互不侵犯到期，仍保持和平`, relation.factions);
    }
    for (const [actor, offer] of Object.entries(relation.offers)) if (offer.expiresDay <= state.day) {
      delete relation.offers[actor]; diplomacyEvent(state, `${state.factions[actor].name}的停战提议到期`, relation.factions);
    }
  }
  for (const fleet of state.fleets) {
    if (fleet.withdrawal?.emergencyUntil !== null && fleet.withdrawal?.emergencyUntil !== undefined) {
      if (fleet.withdrawal.emergencyUntil > state.day) continue;
      const destination = state.systems.find(system => system.id === fleet.withdrawal!.destinationId && controller(system) === fleet.ownerId && operational(system, state.day)) ?? state.systems.find(system => controller(system) === fleet.ownerId && operational(system, state.day));
      if (destination) { fleet.systemId = destination.id; fleet.position = { x: 500, y: 500 }; delete fleet.withdrawal; }
      continue;
    }
    if (fleet.order?.targetFleetId) {
      const target = state.fleets.find(candidate => candidate.id === fleet.order!.targetFleetId);
      if (target && relationship(state, fleet.ownerId, target.ownerId)?.status === 'peace') fleet.order = null;
    }
    if (!fleet.systemId) continue;
    const system = state.systems.find(candidate => candidate.id === fleet.systemId)!;
    if (canEnter(state, fleet.ownerId, controller(system))) {
      if (fleet.withdrawal) { delete fleet.withdrawal; fleet.order = null; }
      if (fleet.order?.route.length) {
        const next = state.systems.find(candidate => candidate.id === fleet.order!.route[0])!;
        if (!canEnter(state, fleet.ownerId, controller(next))) {
          const route = accessiblePath(state, fleet.ownerId, system.id, fleet.order.systemId);
          if (route) fleet.order.route = route;
          else { fleet.order = null; diplomacyEvent(state, `${fleet.name}的航线被关闭边境阻断`, [fleet.ownerId], system.id); }
        }
      }
      continue;
    }
    if (!fleet.withdrawal) {
      fleet.withdrawal = { hostId: controller(system)!, deadline: state.day + RULES.withdrawalDays, emergencyUntil: null, destinationId: null };
      diplomacyEvent(state, `${fleet.name}须在300日内撤出${state.factions[controller(system)!].name}控制区`, [fleet.ownerId, controller(system)!], system.id);
    }
    const destinations = state.systems.filter(candidate => canEnter(state, fleet.ownerId, controller(candidate))).map(candidate => ({ system: candidate, route: accessiblePath(state, fleet.ownerId, system.id, candidate.id, false, fleet.withdrawal!.hostId) })).filter(candidate => candidate.route !== null).sort((first, second) => first.route!.length - second.route!.length || first.system.id.localeCompare(second.system.id));
    if (!destinations.length || fleet.withdrawal.deadline <= state.day) {
      const home = state.systems.filter(candidate => controller(candidate) === fleet.ownerId && operational(candidate, state.day)).sort((first, second) => distance(system.position, first.position) - distance(system.position, second.position) || first.id.localeCompare(second.id))[0];
      fleet.withdrawal.emergencyUntil = state.day + RULES.evacuationDays; fleet.withdrawal.destinationId = home?.id ?? null;
      fleet.systemId = null; fleet.transit = null; fleet.order = null;
      diplomacyEvent(state, `${fleet.name}启动100日紧急撤离${home ? '' : '，暂无可用基地，将在场外等待'}`, [fleet.ownerId, fleet.withdrawal.hostId], system.id);
    } else {
      fleet.order = { systemId: destinations[0].system.id, position: { x: 500, y: 500 }, targetFleetId: null, route: destinations[0].route! };
    }
  }
}

export function migrateState(original: GameState): GameState {
  const state = structuredClone(original);
  if ((state.version as number) === 1) {
    state.version = 3; state.relations = createRelations(factionIds(state), true);
    state.config.factionIds = factionIds(state); state.config.legacy = true;
  }
  if ((original.version as number) < 3) {
    state.version = 3;
    for (const faction of Object.values(state.factions)) {
      faction.policy = { term: Math.floor(state.day / RULES.policyDays), choice: 'none', explicit: false, locked: true };
      faction.militaryIntel = {};
      faction.transitIntel = {};
    }
    diplomacyEvent(state, '规则迁移至版本3：保留旧历史，本届默认无政策，下届正常开放选择', factionIds(state));
  }
  if (original.version < 4) {
    state.version = 4; state.wars = []; state.claims = []; state.grievances = []; state.missions = []; state.cessions = [];
    for (const faction of Object.values(state.factions)) faction.beacon = { term: Math.floor(state.day / RULES.policyDays), totalDays: 0, suppliedDays: 0, disqualified: true, streak: 0, highest: 0 };
    for (const relation of Object.values(state.relations)) if (relation.status === 'war') createWar(state, relation.factions, 'total', true);
    const homes = Object.values(state.factions).map(faction => faction.homeSystemId);
    let candidates = assignHolyCandidates(state.systems, homes, state.config.seed);
    let relaxed = false;
    if (!candidates) { relaxed = true; candidates = assignHolyCandidates(state.systems, homes, state.config.seed, true); }
    v4Event(state, 'religion', candidates ? `V4规则迁移：保留地图，${relaxed ? '使用降级距离规则' : '按严格距离规则'}生成圣地候选` : 'V4规则迁移：旧地图无合适圣地候选，本局无法建立国教', factionIds(state), { candidates, relaxed, rules: V4 });
    for (const actor of factionIds(state)) for (const system of state.systems.filter(system => state.factions[actor].surveyed.includes(system.id))) discoverHoly(state, actor, system, true);
  }
  if (!state.rulesRevision && !state.result) {
    state.rulesRevision = '4.1'; state.revisionStartedDay = state.day;
    state.rivalries = {}; state.conquests = []; state.warAchievements = [];
    for (const war of state.wars ?? []) delete war.hadHostilities;
    v4Event(state, 'war', '规则迁移至4.1：宿敌与战争成果从本分支当日起累计，保留原战争、条约及历史', factionIds(state), { revision: '4.1', fromDay: state.day });
  }
  return state;
}
