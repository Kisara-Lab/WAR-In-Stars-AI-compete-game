import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, FACTION_PRESETS, SHIPS, units } from '../src/shared/rules.js';
import { relationship } from '../src/shared/diplomacy.js';
import { cohesionBreakdown, currentPolicy, sensorCoverage } from '../src/shared/civil.js';
import { V4, activeWar, controller, faithEffects, occupied, observeHolyControl, v4Event } from '../src/shared/v4.js';
import { viewpoint } from '../src/shared/viewpoint.js';
import type { GameState, Fleet } from '../src/shared/types.js';
import { applyAction, BATCH_SCHEMA, StagingArea } from '../src/sim/actions.js';
import { advanceRound, commitActions } from '../src/sim/engine.js';
import { migrateState, updateDiplomacy } from '../src/sim/diplomacy.js';
import { observation, refreshIntel } from '../src/sim/intel.js';
import { shortestPath, stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { createWar, declareWar, settleCaptures, settleWar, updateGrievances, updateWars } from '../src/sim/wars.js';
import { trackBeacon, updateFaith } from '../src/sim/religion.js';

const inline = new SimulationPool(0);
afterAll(() => inline.close());
function fixture() {
  const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted' }, 'v4-fixture');
  state.rulesRevision = '4.1';
  state.fleets = [];
  for (const faction of Object.values(state.factions)) faction.resources = { energy: units(100000), minerals: units(100000), food: units(100000) };
  const home = state.systems[0];
  const target = state.systems.find(system => system.id === home.neighbors[0])!;
  target.ownerId = 'umbra'; target.base = { hull: 40 };
  target.planets[0].ownerId = 'umbra'; target.planets[0].population = 2;
  target.planets[0].structures = [{ id: 'target-mine', type: 'mine' }];
  state.factions.aurora.surveyed.push(target.id);
  state.factions.aurora.intel[target.id] = { day: 0, system: structuredClone(target), fleets: [] };
  const relation = relationship(state, 'aurora', 'umbra')!;
  relation.status = 'peace'; relation.confirmed = [...relation.factions];
  return { state, home, target };
}
function religion(state: GameState, actor = 'aurora') {
  const system = state.systems.find(system => system.id === state.factions[actor].homeSystemId)!;
  system.planets[0].holyCandidate = true;
  applyAction(state, actor, { type: 'establish_religion', args: { planetId: system.planets[0].id, name: `${actor}星海教`, doctrine: '守护圣地与人民', acknowledgePermanent: true } }, `religion-${actor}`);
  return state.factions[actor].faith!;
}
function fleet(actor: string, systemId: string, count: number): Fleet {
  return { id: `${actor}-test`, name: actor, ownerId: actor, systemId, position: { x: 500, y: 500 }, transit: null, order: null, ships: Array.from({ length: count }, (_, index) => ({ id: `${actor}-${index}`, type: 'destroyer', hull: 10 })) };
}
const declaration = (factionId: string, systemId: string) => ({ factionId, warType: 'limited', systemIds: [systemId], grievanceId: null, reason: '维护边境安全' });

describe('V4战争目标与占领', () => {
  it('首次接触占领保留法理归属和全部基地被占国家，900日归还', async () => {
    const { state } = fixture();
    const enemyHome = state.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    for (const system of state.systems) if (system.ownerId === 'umbra' && system !== enemyHome) { system.ownerId = null; system.base = null; for (const planet of system.planets) planet.ownerId = null; }
    relationship(state, 'aurora', 'umbra')!.status = 'contact';
    state.fleets.push(fleet('aurora', enemyHome.id, 10));
    let next = await advanceRound(state, inline);
    expect(next.systems.find(system => system.id === enemyHome.id)?.ownerId).toBe('umbra');
    expect(controller(next.systems.find(system => system.id === enemyHome.id)!)).toBe('aurora');
    expect(next.factions.umbra.eliminatedDay).toBeUndefined();
    expect(activeWar(next, 'aurora', 'umbra')?.type).toBe('contact');
    for (let index = 0; index < 9; index++) next = await advanceRound(next, inline);
    expect(activeWar(next, 'aurora', 'umbra')).toBeUndefined();
    expect(controller(next.systems.find(system => system.id === enemyHome.id)!)).toBe('umbra');
    expect(relationship(next, 'aurora', 'umbra')!.pactUntil).toBe(1990);
  });

  it('总体战必须有理由，条约不能绕过；同轮声明合并不依赖输入顺序', () => {
    const { state, target } = fixture();
    const total = { factionId: 'umbra', warType: 'total', systemIds: [], reason: '收复国土', grievanceId: 'valid' };
    expect(new StagingArea(state, 'aurora').execute('declare_war', total).ok).toBe(false);
    state.grievances!.push({ id: 'valid', actor: 'aurora', target: 'umbra', kind: 'territory', active: true, expiresDay: 9999, source: 'test' });
    relationship(state, 'aurora', 'umbra')!.pactUntil = 10;
    expect(new StagingArea(state, 'aurora').execute('declare_war', total).ok).toBe(false);
    relationship(state, 'aurora', 'umbra')!.pactUntil = null;
    const own = state.systems.find(system => system.id === target.neighbors.find(id => state.systems.find(candidate => candidate.id === id)?.ownerId === 'aurora'))!;
    state.factions.umbra.intel[own.id] = { day: 0, system: structuredClone(own), fleets: [] };
    const first = { type: 'declare_war', args: total };
    const second = { type: 'declare_war', args: declaration('aurora', own.id) };
    const result = commitActions(state, { aurora: [first], umbra: [second] });
    expect(activeWar(result, 'aurora', 'umbra')?.attackers).toEqual(['aurora', 'umbra']);
    expect(activeWar(result, 'aurora', 'umbra')?.type).toBe('total');
    expect(stateHash(result)).toBe(stateHash(commitActions(state, { umbra: [second], aurora: [first] })));
  });

  it('宣称消耗预留、限制数量，必须等待下一回合，母星不能割让', () => {
    const { state, target } = fixture();
    const stage = new StagingArea(state, 'aurora');
    const before = stage.draft.factions.aurora.resources.minerals;
    expect(stage.execute('create_claim', { systemId: target.id }).ok).toBe(true);
    expect(stage.draft.factions.aurora.resources.minerals).toBe(before - units(100));
    expect(stage.execute('create_claim', { systemId: target.id }).ok).toBe(false);
    const args = { ...declaration('umbra', target.id), warType: 'claim' };
    expect(stage.execute('declare_war', args).ok).toBe(false);
    stage.draft.round++;
    expect(new StagingArea(stage.draft, 'aurora').execute('declare_war', args).ok).toBe(true);
    expect(new StagingArea(state, 'aurora').execute('create_claim', { systemId: state.factions.umbra.homeSystemId }).ok).toBe(false);
  });

  it('限定目标占领200日后议和，赔偿封顶、不割地、第三方不受影响', async () => {
    const { state, target } = fixture();
    state.fleets.push(fleet('aurora', target.id, 10));
    const commands = { aurora: [{ type: 'declare_war', args: declaration('umbra', target.id) }] };
    let next = await advanceRound(state, inline, commands);
    expect(activeWar(next, 'aurora', 'umbra')!.goals.aurora[0].heldDays).toBe(90);
    expect(new StagingArea(next, 'aurora').execute('enforce_peace', { factionId: 'umbra' }).ok).toBe(false);
    next = await advanceRound(next, inline); next = await advanceRound(next, inline);
    const before = next.factions.aurora.resources.minerals;
    next.factions.umbra.resources.minerals = units(80);
    const stage = new StagingArea(next, 'aurora');
    expect(stage.execute('enforce_peace', { factionId: 'umbra' }).ok).toBe(true);
    expect(stage.draft.factions.aurora.resources.minerals).toBe(before + units(80));
    expect(stage.draft.factions.umbra.resources.minerals).toBe(0);
    const returned = stage.draft.systems.find(system => system.id === target.id)!;
    expect(controller(returned)).toBe('umbra'); expect(returned.ownerId).toBe('umbra');
    expect(returned.base?.disabledUntil).toBe(600);
    expect(relationship(stage.draft, 'aurora', 'verdant')!.status).toBe('unknown');
  });

  it('割让只兑现已控制的宣称，非目标归还且取消原主项目', () => {
    const { state, target } = fixture();
    const war = declareWar(state, 'aurora', 'umbra', 'claim', [target.id], '宣称');
    target.controllerId = 'aurora'; target.occupationWarId = war.id;
    target.projects.push({ id: 'unfinished', ownerId: 'umbra', kind: 'building', planetId: target.planets[0].id, structureType: 'mine', shipType: null, progress: 0, requiredDays: 200, cost: { minerals: units(120), energy: 0, food: 0 }, createdDay: 0 });
    const home = state.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    home.controllerId = 'aurora'; home.occupationWarId = war.id;
    war.goals.aurora[0].heldDays = 200;
    settleWar(state, war, true, '测试结算');
    expect(target.ownerId).toBe('aurora'); expect(target.projects).toEqual([]);
    expect(controller(home)).toBe('umbra'); expect(state.cessions).toHaveLength(1);
  });

  it('中立第三方只能解放，不能借打占领军吞并中立法理领土', () => {
    const { state, target } = fixture();
    const war = createWar(state, ['aurora', 'umbra'], 'limited');
    target.controllerId = 'aurora'; target.occupationWarId = war.id;
    createWar(state, ['aurora', 'verdant'], 'total');
    target.base = { hull: 20 };
    settleCaptures(state, [{ systemId: target.id, previousOwner: 'umbra', previousController: 'aurora', captor: 'verdant', pair: ['aurora', 'verdant'] }]);
    expect(target.ownerId).toBe('umbra'); expect(controller(target)).toBe('umbra');
    expect(state.cessions).toHaveLength(0);
  });

  it('目标计时中断、疲劳到顶结算、不处分第三方领土', () => {
    const { state, target } = fixture();
    const war = declareWar(state, 'aurora', 'umbra', 'limited', [target.id], '边境');
    target.controllerId = 'aurora'; target.occupationWarId = war.id;
    for (let day = 10; day <= 100; day += 10) { state.day = day; updateWars(state); }
    expect(war.goals.aurora[0].heldDays).toBe(90);
    delete target.controllerId; state.day = 110; updateWars(state);
    expect(war.goals.aurora[0].heldDays).toBe(0);
    target.ownerId = 'verdant'; state.day = 120; updateWars(state);
    expect(war.endedDay).toBe(120); expect(target.ownerId).toBe('verdant');
    const next = fixture(); const exhausted = declareWar(next.state, 'aurora', 'umbra', 'limited', [next.target.id], '边境');
    exhausted.fatigue.aurora = 100; next.state.day = 10; updateWars(next.state);
    expect(exhausted.endedDay).toBe(10);
  });

  it('占领时建设和LRS暂停，经济与凝聚力归属分离', async () => {
    const { state, home } = fixture();
    const war = createWar(state, ['aurora', 'umbra'], 'limited');
    home.controllerId = 'umbra'; home.occupationWarId = war.id;
    home.planets[0].structures.push({ id: 'lrs', type: 'lrs' });
    expect(sensorCoverage(state, 'aurora').size).toBe(0);
    expect(cohesionBreakdown(state, 'aurora').buildings).toBe(-2);
    expect(new StagingArea(state, 'aurora').execute('queue_ships', { planetId: home.planets[0].id, count: 1, shipType: 'destroyer' }).ok).toBe(false);
    const before = state.factions.aurora.resources.minerals;
    const next = await advanceRound(state, inline);
    expect(next.factions.aurora.resources.minerals).toBe(before);
    expect(next.factions.aurora.eliminatedDay).toBeUndefined();
  });
});

describe('国教、地方影响与灯塔', () => {
  it.each([4, 6, 8])('%i方候选远离母星且对称可达，不由LRS泄露', count => {
    const ids = FACTION_PRESETS.slice(0, count).map(faction => faction.id);
    for (let seed = 0; seed < 8; seed++) {
      const state = createGame({ ...DEFAULT_CONFIG, factionIds: ids, systemCount: count * 6, seed: `holy-test-${seed}` }, undefined, '5.0');
      const homes = Object.values(state.factions).map(faction => faction.homeSystemId);
      const candidates = state.systems.filter(system => system.planets.some(planet => planet.holyCandidate));
      expect(candidates.length).toBeGreaterThanOrEqual(count); expect(candidates.length % count).toBe(0);
      for (const system of candidates) {
        const hops = homes.map(home => shortestPath(state.systems, home, system.id)!.length).sort((first, second) => first - second);
        expect(hops[0]).toBeGreaterThanOrEqual(2); expect(hops[1]).toBeLessThanOrEqual(4); expect(hops[1] - hops[0]).toBeLessThanOrEqual(1);
      }
      expect(observation(state, ids[0]).systems.filter(system => !system.surveyed).every(system => system.planets === null)).toBe(true);
    }
  });

  it('立教永久锁定主圣地，当前和预约乌托邦均禁止立教', () => {
    const { state, home } = fixture();
    home.planets[0].holyCandidate = true;
    const args = { planetId: home.planets[0].id, name: '星海教', doctrine: '和平与勇气', acknowledgePermanent: true };
    state.factions.aurora.policy!.choice = 'utopia';
    expect(new StagingArea(state, 'aurora').execute('establish_religion', args).ok).toBe(false);
    state.factions.aurora.policy!.choice = 'none'; state.factions.aurora.policy!.next = { term: 1, choice: 'utopia' };
    expect(new StagingArea(state, 'aurora').execute('establish_religion', args).ok).toBe(false);
    delete state.factions.aurora.policy!.next;
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('establish_religion', args).ok).toBe(true);
    expect(stage.execute('establish_religion', { ...args, name: '改宗' }).ok).toBe(false);
    expect(stage.execute('choose_policy', { policy: 'utopia' }).ok).toBe(false);
    expect(stage.draft.factions.aurora.faith!.sites[0].planetId).toBe(home.planets[0].id);
  });

  it('未祝圣失守没有危机；祝圣固定300日且短缺不延长', async () => {
    const { state, home } = fixture();
    religion(state); home.controllerId = 'umbra'; state.day = 10; updateFaith(state);
    expect(state.factions.aurora.faith!.crisis).toBe(0);
    delete home.controllerId; state.day = 0;
    state.factions.aurora.faith!.crisis = 10;
    state.factions.aurora.shortages = { energy: true, food: true, minerals: true };
    applyAction(state, 'aurora', { type: 'consecrate', args: { planetId: home.planets[0].id } }, 'bless');
    let next = await advanceRound(state, inline); next = await advanceRound(next, inline);
    expect(next.factions.aurora.faith!.sites[0].consecratedDay).toBeUndefined();
    next = await advanceRound(next, inline);
    expect(next.factions.aurora.faith!.sites[0].consecratedDay).toBe(300);
    expect(next.systems[0].planets[0].structures.length).toBe(home.planets[0].structures.length);
  });

  it('圣地失守与收复不能反复刷收益，危机跨阈值影响全部倍率', () => {
    const { state, home } = fixture();
    const faith = religion(state); faith.sites[0].consecratedDay = 0;
    createWar(state, ['aurora', 'umbra'], 'limited');
    home.controllerId = 'umbra'; state.day = 10; updateFaith(state);
    expect(faith.crisis).toBe(30); expect(faithEffects(state.factions.aurora, state.day).production).toBe(0.95);
    delete home.controllerId; state.day = 20; updateFaith(state);
    const recovered = faith.crisis;
    home.controllerId = 'umbra'; state.day = 30; updateFaith(state);
    delete home.controllerId; state.day = 40; updateFaith(state);
    expect(faith.crisis).toBeCloseTo(recovered - 0.1, 4);
    expect(faith.sites[0].lossKeys).toHaveLength(1); expect(faith.sites[0].recoveryKeys).toHaveLength(1);
    faith.crisis = 75;
    expect(faithEffects(state.factions.aurora, state.day)).toMatchObject({ production: 0.7, combat: 0.75, unity: -8 });
  });

  it('争端由持续危机触发，回应有资源预留和720日冷却', () => {
    const { state } = fixture(); const faith = religion(state);
    faith.crisis = 60; state.factions.aurora.shortages.food = true;
    for (let day = 10; day <= 200; day += 10) { state.day = day; updateFaith(state); }
    expect(faith.dispute?.cause).toBe('持续信仰危机');
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('respond_dispute', { response: 'zeal', warId: null, systemId: null }).ok).toBe(false);
    expect(stage.execute('respond_dispute', { response: 'reform', warId: null, systemId: null }).ok).toBe(true);
    expect(stage.draft.factions.aurora.faith!.response!.cooldownUntil).toBe(920);
    stage.draft.factions.aurora.faith!.crisis = 0;
    expect(faithEffects(stage.draft.factions.aurora, 210)).toMatchObject({ combat: 1, unity: 0 });
  });

  it('传教不改国体，三年条约后允许反制，五年权利到期渐退', () => {
    const { state, target } = fixture(); religion(state);
    const war = declareWar(state, 'aurora', 'umbra', 'missionary', [target.id], '传播');
    target.controllerId = 'aurora'; target.occupationWarId = war.id; war.goals.aurora[0].heldDays = 200;
    settleWar(state, war, true, '传教胜利');
    expect(state.factions.umbra.faith).toBeUndefined();
    expect(target.planets[0].influence?.aurora).toBe(20);
    expect(state.missions![0].expiresDay).toBe(1800);
    const args = { ...declaration('aurora', target.id), warType: 'ideological' };
    expect(new StagingArea(state, 'umbra').execute('declare_war', args).ok).toBe(false);
    for (let day = 10; day <= 1080; day += 10) { state.day = day; updateFaith(state); }
    updateDiplomacy(state);
    expect(new StagingArea(state, 'umbra').execute('declare_war', args).ok).toBe(true);
    for (let day = 1090; day <= 1800; day += 10) { state.day = day; updateFaith(state); }
    const peak = target.planets[0].influence!.aurora;
    state.day = 1810; updateFaith(state);
    expect(target.planets[0].influence!.aurora).toBeCloseTo(peak - 0.2);
  });

  it('连续完整乌托邦任期在边界晋级，供应不足与政策中断归零', () => {
    const { state } = fixture(); const faction = state.factions.aurora;
    faction.policy!.choice = 'utopia';
    for (let day = 10; day <= 2160; day += 10) { state.day = day; trackBeacon(state, state.factions); }
    expect(faction.beacon!.streak).toBe(3); expect(faction.beacon!.highest).toBe(2);
    expect(currentPolicy(state, 'aurora').energy).toBe(0.8);
    expect(cohesionBreakdown(state, 'aurora').beacon).toBe(2);
    faction.policy!.choice = 'balanced';
    for (let day = 2170; day <= 2880; day += 10) { state.day = day; trackBeacon(state, state.factions); }
    expect(faction.beacon!.streak).toBe(0); expect(faction.beacon!.highest).toBe(2);
    faction.policy!.choice = 'utopia'; faction.shortages.food = true;
    for (let day = 2890; day <= 3600; day += 10) { state.day = day; trackBeacon(state, state.factions); }
    expect(faction.beacon!.streak).toBe(0);
  });

  it('私人危机、目标经济、第三方战争不通过模型和观察视角泄露', () => {
    const { state, target } = fixture(); religion(state, 'umbra');
    state.factions.umbra.faith!.crisis = 77.123;
    state.factions.umbra.faith!.dispute = { id: 'secret-dispute', cause: '内部秘密争端', openedDay: 0 };
    createWar(state, ['umbra', 'verdant'], 'limited');
    const report = observation(state, 'aurora');
    expect(report.wars).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain('77.123'); expect(JSON.stringify(report)).not.toContain('内部秘密争端');
    const view = viewpoint(state, 'aurora');
    expect(view.factions.umbra.faith).toBeUndefined(); expect(view.wars).toHaveLength(0);
    const unknown = view.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    expect(unknown.planets).toHaveLength(0);
    expect(view.systems.find(system => system.id === target.id)!.planets[0].influence).toBeUndefined();
  });

  it('宣战工具结果不泄露对手全国军力，未探索目标不能用工具探测殖民地', () => {
    const { state, target } = fixture(); religion(state);
    state.fleets.push(fleet('umbra', state.factions.umbra.homeSystemId, 37));
    const stage = new StagingArea(state, 'aurora');
    const declarationResult = stage.execute('declare_war', declaration('umbra', target.id));
    expect(declarationResult.ok).toBe(true);
    expect((declarationResult as { result: { openingValue: Record<string, number> } }).result.openingValue.umbra).toBeUndefined();
    state.factions.aurora.surveyed = state.factions.aurora.surveyed.filter(id => id !== target.id);
    state.fleets.push(fleet('aurora', target.id, 4));
    const withColony = new StagingArea(state, 'aurora').execute('declare_war', { ...declaration('umbra', target.id), warType: 'missionary' });
    target.planets[0].population = 0;
    const empty = new StagingArea(state, 'aurora').execute('declare_war', { ...declaration('umbra', target.id), warType: 'missionary' });
    expect(withColony.ok).toBe(false); expect(empty).toEqual(withColony);
  });
});

describe('V4一致性与迁移', () => {
  it('同一步失守和收复仍完整记录，历史事件不被后续状态改变', () => {
    const { state, home } = fixture(); const faith = religion(state); faith.sites[0].consecratedDay = 0;
    const war = createWar(state, ['aurora', 'umbra'], 'limited'); state.day = 10;
    home.controllerId = 'umbra'; observeHolyControl(state, home, war.id);
    delete home.controllerId; observeHolyControl(state, home, war.id);
    updateFaith(state);
    expect(faith.crisis).toBeCloseTo(14.9);
    expect(state.events.filter(event => event.type === 'religion' && /失守|收复/.test(event.text))).toHaveLength(2);
    const original = JSON.stringify(state.events.find(event => event.type === 'war')!.details);
    war.fatigue.aurora = 99;
    expect(JSON.stringify(state.events.find(event => event.type === 'war')!.details)).toBe(original);
  });

  it('事件前端截断后同日追加不会复用事件ID', () => {
    const { state } = fixture();
    for (let index = 0; index < 1600; index++) v4Event(state, 'religion', `事件${index}`, ['aurora']);
    const previous = new Set(state.events.map(event => event.id));
    state.events = state.events.slice(-1500);
    v4Event(state, 'religion', '同日新事件', ['aurora']);
    expect(previous.has(state.events.at(-1)!.id)).toBe(false);
  });

  it('总体战双方全毁不会抹除第三方法理领土', () => {
    const { state, target } = fixture(); target.controllerId = 'aurora'; target.base = { hull: 0, disabledUntil: 100 };
    createWar(state, ['aurora', 'verdant'], 'total');
    settleCaptures(state, [{ systemId: target.id, previousOwner: 'umbra', previousController: 'aurora', captor: null, pair: ['aurora', 'verdant'] }]);
    expect(target.ownerId).toBe('umbra'); expect(target.base?.disabledUntil).toBe(100);
    expect(state.cessions).toHaveLength(0);
  });

  it('重大理由只由事实产生，原因消失保留1080日且单个普通星系不足', () => {
    const { state, target, home } = fixture();
    state.cessions!.push({ day: 0, from: 'aurora', to: 'umbra', systemId: target.id, warId: 'old' });
    updateGrievances(state); expect(state.grievances).toHaveLength(0);
    home.controllerId = 'umbra'; updateGrievances(state);
    const grievance = state.grievances!.find(grievance => grievance.kind === 'home')!;
    expect(grievance.active).toBe(true);
    state.day = 100; delete home.controllerId; updateGrievances(state);
    expect(grievance).toMatchObject({ active: false, expiresDay: 1180 });
  });

  it('祝圣多星系并行完成的事件顺序跨worker一致', async () => {
    const { state } = fixture(); religion(state);
    const candidates = state.systems.filter(system => system.planets.some(planet => planet.holyCandidate)).slice(0, 3);
    for (const system of candidates) {
      system.ownerId = 'aurora'; system.base = { hull: 40 };
      const planet = system.planets.find(planet => planet.holyCandidate)!; planet.ownerId = 'aurora'; planet.population = 2;
      state.systems.find(candidate => candidate.id === system.id)!.projects.push({ id: `${planet.id}-bless`, ownerId: 'aurora', kind: 'consecrate', planetId: planet.id, structureType: null, shipType: null, progress: units(290), requiredDays: 300, cost: { energy: 0, minerals: units(200), food: units(100) }, createdDay: 0 });
    }
    const workers = new SimulationPool(3);
    try { expect(stateHash(await advanceRound(state, inline))).toBe(stateHash(await advanceRound(state, workers))); }
    finally { await workers.close(); }
  });

  it('圣战承诺失败只结算一次，改革720日后恢复宗教正增益', () => {
    const { state, target } = fixture(); const faith = religion(state);
    faith.dispute = { id: 'dispute', cause: '危机', openedDay: 0 };
    const war = declareWar(state, 'aurora', 'umbra', 'limited', [target.id], '边境目标');
    applyAction(state, 'aurora', { type: 'respond_dispute', args: { response: 'zeal', warId: war.id, systemId: target.id } }, 'response');
    state.factions.aurora.shortages.food = true;
    state.day = 720; updateFaith(state); expect(faith.crisis).toBe(15);
    state.day = 730; updateFaith(state); expect(faith.crisis).toBe(15);
    faith.response = { type: 'reform', startsDay: 0, effectUntil: 300, cooldownUntil: 720 }; faith.crisis = 0;
    expect(faithEffects(state.factions.aurora, 710).combat).toBe(1);
    expect(faithEffects(state.factions.aurora, 720).combat).toBe(1.08);
  });

  it('混合战争与宗教在不同线程数及JSON恢复后哈希一致', async () => {
    const { state, target } = fixture(); religion(state); religion(state, 'umbra');
    state.fleets.push(fleet('aurora', target.id, 10));
    const workers = new SimulationPool(3);
    try {
      const actions = { aurora: [{ type: 'declare_war', args: declaration('umbra', target.id) }] };
      const first = await advanceRound(state, inline, actions);
      expect(stateHash(first)).toBe(stateHash(await advanceRound(state, workers, actions)));
      expect(stateHash(await advanceRound(first, inline))).toBe(stateHash(await advanceRound(JSON.parse(JSON.stringify(first)), workers)));
    } finally { await workers.close(); }
  });

  it('V3迁移保留地图和政策，原档不变，旧战争标记兼容总体战', () => {
    const { state } = fixture(); state.version = 3; state.day = 7900; state.round = 79;
    relationship(state, 'aurora', 'umbra')!.status = 'war';
    state.factions.aurora.policy = { term: 10, choice: 'utopia', next: { term: 11, choice: 'balanced' }, explicit: true, locked: true };
    const before = stateHash(state); const next = migrateState(state);
    expect(stateHash(state)).toBe(before); expect(next.version).toBe(4);
    expect(next.systems.map(system => ({ id: system.id, position: system.position, neighbors: system.neighbors }))).toEqual(state.systems.map(system => ({ id: system.id, position: system.position, neighbors: system.neighbors })));
    expect(next.factions.aurora.policy).toEqual(state.factions.aurora.policy);
    expect(next.factions.aurora.beacon).toMatchObject({ streak: 0, disqualified: true });
    expect(activeWar(next, 'aurora', 'umbra')).toMatchObject({ type: 'total', legacy: true });
  });

  it('批量Schema包含全部新命令，明确确认不可省略', () => {
    expect(BATCH_SCHEMA.safeParse({ orders: [{ type: 'declare_war', args: declaration('umbra', 's1') }, { type: 'establish_religion', args: { planetId: 's1-p0', name: '圣光', doctrine: '守护', acknowledgePermanent: true } }], summary: '目标和风险已确认' }).success).toBe(true);
    expect(new StagingArea(fixture().state, 'aurora').execute('establish_religion', { planetId: 's0-p0', name: '圣光', doctrine: '守护' }).ok).toBe(false);
  });
});
