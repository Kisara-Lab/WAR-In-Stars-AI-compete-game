import { ModelProvider } from '../src/server/provider.js';
import { batchCall, response } from './helpers/responses.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchStore } from '../src/server/storage.js';
import { emptyMetrics } from '../src/sim/bot.js';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { borders, conquestFor, conquestOptions, escalationView, warReasons } from '../src/shared/escalation.js';
import { relationship, relationKey } from '../src/shared/diplomacy.js';
import { cohesionBreakdown } from '../src/shared/civil.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { viewpoint } from '../src/shared/viewpoint.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { StagingArea, BATCH_SCHEMA } from '../src/sim/actions.js';
import { advanceRound, commitActions } from '../src/sim/engine.js';
import { createWar, settleWar, settleCaptures, accountBattleLosses, cedeSystem } from '../src/sim/wars.js';
import { awardAchievement, recordRivalry, updateEscalation } from '../src/sim/escalation.js';
import { migrateState } from '../src/sim/diplomacy.js';
import { SimulationPool } from '../src/sim/pool.js';
import { stateHash } from '../src/sim/math.js';
import { observation } from '../src/sim/intel.js';
import type { GameState, LocalEvent } from '../src/shared/types.js';

const inline = new SimulationPool(0);
const workers = new SimulationPool(2);
afterAll(async () => { await inline.close(); await workers.close(); });
function fixture() {
  const state = createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted' }, 'escalation');
  state.rulesRevision = '4.1';
  const own = state.systems[0];
  const target = state.systems.find(system => own.neighbors.includes(system.id) && !system.ownerId)!;
  target.ownerId = 'umbra'; target.base = { hull: 40 };
  target.planets[0].ownerId = 'umbra'; target.planets[0].population = 2;
  state.factions.aurora.surveyed.push(target.id);
  state.factions.aurora.intel[target.id] = { day: 0, system: structuredClone(target), fleets: [] };
  const relation = relationship(state, 'aurora', 'umbra')!;
  relation.status = 'peace'; relation.confirmed = [...relation.factions];
  for (const faction of Object.values(state.factions)) faction.resources = { energy: units(100000), minerals: units(100000), food: units(100000) };
  return { state, target, relation };
}
const prepare = { type: 'prepare_conquest', args: { factionId: 'umbra', reason: '公开战略征服准备' } };
function start(state: GameState) {
  const staged = new StagingArea(state, 'aurora');
  expect(staged.execute(prepare.type, prepare.args).ok).toBe(true);
  return staged.draft;
}
function finishWar(state: GameState, contact = false, actual = true) {
  const war = createWar(state, ['aurora', 'umbra'], contact ? 'contact' : 'limited');
  war.hadHostilities = actual;
  settleWar(state, war, false, '测试议和');
  return war;
}
describe('4.1 宿敌、征服与成果', () => {
  it('SSE回合内修正总体战参数，宣战与进军整批生效，原始世界不提前变化', async () => {
    const { state: original, target } = fixture();
    const state = start(original);
    state.day = 400; state.round = 4;
    const before = stateHash(state);
    let count = 0;
    const requestBodies: Record<string, unknown>[] = [];
    const provider = new ModelProvider({ base: 'https://war.invalid/v1', key: 'test-war' }, async (_url, init) => {
      requestBodies.push(JSON.parse(init!.body as string));
      count++;
      return response([batchCall([
        { type: 'declare_war', args: { factionId: 'umbra', warType: 'total', systemIds: count === 1 ? [target.id] : [], reason: '征服', grievanceId: state.conquests![0].id } },
        { type: 'move_fleet', args: { fleetId: 'aurora-initial', systemId: target.id, x: 500, y: 500, targetFleetId: null } },
      ], 'attempt-' + count)]);
    });
    const decision = await provider.decide(state, 'aurora', new AbortController().signal);
    expect(stateHash(state)).toBe(before);
    expect(decision.actions.map(action => action.type)).toEqual(['declare_war', 'move_fleet']);
    expect(decision.trace[0]).toMatchObject({ disposition: 'rejected', ok: false });
    expect(decision.trace[0].message).toContain('TOTAL_WAR_TARGETS_MUST_BE_EMPTY');
    expect(JSON.stringify(requestBodies[1].input)).toContain('整批退回');
    const final = await advanceRound(state, inline, { aurora: decision.actions });
    expect(final.wars!.some(war => war.type === 'total' && war.attackers.includes('aurora'))).toBe(true);
    expect(final.conquests![0].outcome).toContain('资格用于');
  });
  it('行动提示区分没有理由、仍可准备、条约限制和成熟资格；不读取隐藏军力', () => {
    const { state, relation } = fixture();
    state.factions.aurora.policy!.choice = 'utopia';
    relation.pactUntil = 1000;
    const option = conquestOptions(state, 'aurora')!.find(item => item.target === 'umbra')!;
    expect(option).toMatchObject({ canPrepareNow: true, canDeclareTotalNow: false, earliestDeclarationAfterNewPreparation: 1000 });
    expect(option.policyConsequence).toContain('乌托邦不禁止');
    state.fleets.find(fleet => fleet.ownerId === 'umbra')!.ships = [];
    expect(conquestOptions(state, 'aurora')!.find(item => item.target === 'umbra')).toEqual(option);
    const next = start(state);
    next.day = 360; updateEscalation(next);
    expect(conquestOptions(next, 'aurora')!.find(item => item.target === 'umbra')).toMatchObject({ canPrepareNow: false, canDeclareTotalNow: false, pactRemainingDays: 640 });
    next.day = 1000;
    const ready = conquestOptions(next, 'aurora')!.find(item => item.target === 'umbra')!;
    expect(ready.canDeclareTotalNow).toBe(true);
    expect(ready.usableReasonIds).toHaveLength(1);
    expect(conquestOptions(next, 'verdant')).toEqual([]);
    next.conquests![0].endedDay = next.day;
    expect(conquestOptions(next, 'aurora')!.find(item => item.target === 'umbra')).toMatchObject({ canPrepareNow: true, canDeclareTotalNow: false });
  });
  it('三场正式实战计数去重，条约期不消退且到期后有完整窗口', () => {
    const { state, relation } = fixture();
    finishWar(state, true); finishWar(state, false, false);
    expect(state.rivalries).toEqual({});
    for (let index = 0; index < 3; index++) { state.day += 1200; const war = finishWar(state); recordRivalry(state, war); }
    const key = relationKey('aurora', 'umbra');
    expect(state.rivalries![key].warIds).toHaveLength(3);
    for (let tick = 0; tick < 108; tick++) { state.day += 10; updateEscalation(state); }
    expect(state.rivalries![key].freePeaceDays).toBe(0);
    expect(warReasons(state, 'aurora').some(item => item.kind === 'rivalry' && item.availableDay === state.day)).toBe(true);
    relation.pactUntil = null;
    const third = createWar(state, ['aurora', 'verdant'], 'limited');
    for (let tick = 0; tick < 107; tick++) { state.day += 10; updateEscalation(state); }
    expect(state.rivalries![key].freePeaceDays).toBe(1070);
    expect(third.endedDay).toBeUndefined();
    state.day += 10; updateEscalation(state);
    expect(state.rivalries![key]).toBeUndefined();
    expect(warReasons(state, 'aurora').some(item => item.kind === 'rivalry')).toBe(false);
  });
  it('重新交战清零双边自由和平计时，不改变第三方', () => {
    const { state } = fixture(); finishWar(state);
    const item = state.rivalries![relationKey('aurora', 'umbra')]; item.freePeaceDays = 500;
    createWar(state, ['aurora', 'verdant'], 'limited');
    expect(item.freePeaceDays).toBe(500);
    state.day = 2000; createWar(state, ['aurora', 'umbra'], 'limited');
    expect(item.freePeaceDays).toBe(0);
  });
  it('战斗船体损失和基地占领才标记实战', () => {
    const { state, target } = fixture();
    const war = createWar(state, ['aurora', 'umbra'], 'limited');
    const event = { type: 'battle', day: 10, systemId: target.id, audience: [], text: '', details: { pair: war.factions, order: 1, participants: [{ id: 'base', ownerId: 'umbra', ships: [], baseHull: 40 }], remaining: [{ id: 'base', ships: [], baseHull: 20 }] } } as LocalEvent;
    accountBattleLosses(state, [event], { aurora: 180, umbra: 180 });
    expect(war.hadHostilities).toBe(true);
    delete war.hadHostilities;
    settleCaptures(state, [{ systemId: target.id, previousOwner: 'umbra', previousController: 'umbra', captor: 'aurora', pair: ['aurora', 'umbra'] }]);
    expect(war.hadHostilities).toBe(true);
  });
  it('准备预留资源与凝聚力，单国唯一；撤回不退款', () => {
    const { state } = fixture();
    const next = start(state);
    expect(next.factions.aurora.resources.minerals).toBe(state.factions.aurora.resources.minerals - units(300));
    expect(next.factions.aurora.resources.food).toBe(state.factions.aurora.resources.food - units(100));
    expect(next.factions.aurora.unity).toBe(state.factions.aurora.unity - 1000);
    const stage = new StagingArea(next, 'aurora');
    expect(stage.execute(prepare.type, prepare.args).ok).toBe(false);
    expect(stage.execute('cancel_conquest', {}).ok).toBe(true);
    expect(stage.draft.factions.aurora.resources).toEqual(next.factions.aurora.resources);
    expect(conquestFor(stage.draft, 'aurora')).toBeUndefined();
    state.factions.aurora.unity = 999;
    expect(new StagingArea(state, 'aurora').execute(prepare.type, prepare.args).ok).toBe(false);
  });
  it('360日精确成熟；条约暂停1080日资格消退且不会赠送额外十日', async () => {
    const setup = fixture(); setup.relation.pactUntil = 400;
    let state = start(setup.state);
    state.day = 350;
    expect(cohesionBreakdown(state, 'aurora').conquest).toBe(-2);
    expect(warReasons(state, 'aurora')).toHaveLength(0);
    state.day = 360; updateEscalation(state);
    expect(cohesionBreakdown(state, 'aurora').conquest).toBe(0);
    const reason = warReasons(state, 'aurora')[0];
    expect(reason.availableDay).toBe(400);
    expect(new StagingArea(state, 'aurora').execute('declare_war', { factionId: 'umbra', warType: 'total', systemIds: [], reason: '征服', grievanceId: reason.id }).ok).toBe(false);
    state.day = 390; state = await advanceRound(state, inline);
    expect(conquestFor(state, 'aurora')!.freePeaceDays).toBe(90);
    state.day = 1470; conquestFor(state, 'aurora')!.freePeaceDays = 1070;
    state.day += 10; updateEscalation(state);
    expect(conquestFor(state, 'aurora')).toBeUndefined();
  });
  it('准备完整360日凝聚力成本按36个步计算', async () => {
    const { state } = fixture();
    let next = start(state);
    const batches: { day: number; economy: unknown[] }[] = [];
    for (let round = 0; round < 4; round++) next = await advanceRound(next, inline, {}, async batch => { batches.push(batch); });
    const records = batches.flatMap(batch => batch.economy as { factionId: string; before: { unity: number }; after: { unity: number }; cohesion: { conquest: number } }[]).filter(item => item.factionId === 'aurora');
    expect(records).toHaveLength(40);
    expect(records.slice(0,36).every(item => item.after.unity - item.before.unity === -10)).toBe(true);
    expect(records.slice(36).every(item => item.after.unity - item.before.unity === 10)).toBe(true);
    expect(records.slice(0,36).every(item => item.cohesion.conquest === -2)).toBe(true);
    expect(records.slice(36).every(item => item.cohesion.conquest === 0)).toBe(true);
  });
  it('隐藏军力不影响合法性；不相关双边准备不可见', () => {
    const { state } = fixture();
    const original = new StagingArea(state, 'aurora').execute(prepare.type, prepare.args);
    state.fleets.find(fleet => fleet.ownerId === 'umbra')!.ships.push(...Array.from({length:100}, (_,index) => ({ id: 'hidden-'+index, type: 'dreadnought' as const, hull: 200 })));
    expect(new StagingArea(state, 'aurora').execute(prepare.type, prepare.args)).toEqual(original);
    const next = start(state);
    expect(escalationView(next, 'verdant')!.preparations).toEqual([]);
    expect(viewpoint(next, 'verdant').conquests).toEqual([]);
    expect(observation(next, 'verdant').escalation!.preparations).toEqual([]);
  });
  it('失去接壤只暂停资格，宣战使用资格且条约不能绕过', () => {
    const setup = fixture(); const state = start(setup.state);
    state.day = 360; updateEscalation(state);
    const id = conquestFor(state, 'aurora')!.id;
    const args = { factionId:'umbra',warType:'total',systemIds:[],reason:'成熟征服',grievanceId:id };
    setup.target.ownerId = 'verdant';
    const target = state.systems.find(system => system.id === setup.target.id)!;
    target.ownerId = 'verdant';
    expect(borders(state, 'aurora', 'umbra', true)).toBe(false);
    expect(new StagingArea(state, 'aurora').execute('declare_war', args).ok).toBe(true);
    const rejected = commitActions(state, { aurora: [{type:'declare_war',args}] });
    expect(rejected.wars).toHaveLength(0);
    expect(conquestFor(rejected, 'aurora')).toBeDefined();
    target.ownerId = 'umbra';
    const accepted = commitActions(state, { aurora: [{type:'declare_war',args}] });
    expect(accepted.wars![0].type).toBe('total');
    expect(conquestFor(accepted, 'aurora')).toBeUndefined();
  });
  it('同轮宣战优先于准备；双边其他战争取消，第三方战争保留', () => {
    const { state, target } = fixture();
    state.factions.umbra.intel[state.systems[0].id] = { day:0, system:structuredClone(state.systems[0]),fleets:[] };
    const attack = {type:'declare_war',args:{factionId:'aurora',warType:'limited',systemIds:[state.systems[0].id],reason:'边境',grievanceId:null}};
    const first = commitActions(state, {aurora:[prepare],umbra:[attack]});
    const second = commitActions(state, {umbra:[attack],aurora:[prepare]});
    expect(stateHash(first)).toBe(stateHash(second));
    expect(first.conquests).toHaveLength(0);
    expect(first.factions.aurora.resources).toEqual(state.factions.aurora.resources);
    const next = start(state);
    createWar(next,['aurora','verdant'],'limited'); updateEscalation(next,0);
    expect(conquestFor(next,'aurora')).toBeDefined();
    createWar(next,['aurora','umbra'],'limited'); updateEscalation(next,0);
    expect(conquestFor(next,'aurora')).toBeUndefined();
    expect(target.ownerId).toBe('umbra');
  });
  it('成果去重、领土持有检查、目标500封顶和旧评分', () => {
    const {state,target}=fixture();
    const old=structuredClone(state); delete old.rulesRevision;
    expect(scoreBreakdown(old,'aurora').fleet).toBe(scoreBreakdown(state,'aurora').fleet*2);
    const war=createWar(state,['aurora','umbra'],'total');
    cedeSystem(state,target,'aurora',war.id);
    expect(scoreBreakdown(state,'aurora').territory).toBe(100);
    cedeSystem(state,target,'umbra',war.id);
    expect(scoreBreakdown(state,'aurora').territory).toBe(0);
    cedeSystem(state,target,'aurora',war.id);
    expect(scoreBreakdown(state,'aurora').territory).toBe(100);
    for(let index=0;index<15;index++) for(let repeat=0;repeat<2;repeat++) awardAchievement(state,{actor:'aurora',target:'umbra',systemId:'goal-'+index,type:'limited',day:state.day,warId:war.id});
    expect(state.warAchievements!.filter(item=>item.actor==='aurora'&&item.type==='limited')).toHaveLength(15);
    expect(scoreBreakdown(state,'aurora').objectives).toBe(500);
  });
  it('跨worker及JSON恢复一致，原V4迁移不补历史且保留原档', async () => {
    const {state}=fixture(); const old=structuredClone(state);
    delete old.rulesRevision; delete old.rivalries; delete old.conquests; delete old.warAchievements;
    finishWar(old); const hash=stateHash(old);
    const migrated=migrateState(old);
    expect(stateHash(old)).toBe(hash); expect(migrated.rivalries).toEqual({});
    expect(migrated.warAchievements).toEqual([]);
    const first=await advanceRound(state,inline,{aurora:[prepare]});
    const parallel=await advanceRound(state,workers,{aurora:[prepare]});
    expect(stateHash(first)).toBe(stateHash(parallel));
    expect(stateHash(await advanceRound(first,inline))).toBe(stateHash(await advanceRound(JSON.parse(JSON.stringify(parallel)),workers)));
    old.result={winner:'aurora',reason:'score',scores:{}};
    expect(migrateState(old).rulesRevision).toBeUndefined();
  });
  it('成熟征服实际宣战、吞并、协商停战完整链路及保存恢复', async () => {
    const setup=fixture();
    let state=start(setup.state);
    state.day=360; updateEscalation(state);
    const id=conquestFor(state,'aurora')!.id;
    const fleet=state.fleets.find(item=>item.ownerId==='aurora')!;
    fleet.systemId=setup.target.id;fleet.position={x:500,y:500};
    fleet.ships=Array.from({length:20},(_,index)=>({id:'assault-'+index,type:'destroyer' as const,hull:10}));
    state=await advanceRound(state,inline,{aurora:[{type:'declare_war',args:{factionId:'umbra',warType:'total',systemIds:[],grievanceId:id,reason:'兑现公开征服准备'}}]});
    expect(state.systems.find(item=>item.id===setup.target.id)!.ownerId).toBe('aurora');
    expect(scoreBreakdown(state,'aurora').territory).toBe(100);
    const war=state.wars!.find(item=>item.type==='total')!;
    settleWar(state,war,false,'双方同意停战');
    expect(relationship(state,'aurora','umbra')!.pactUntil).toBe(state.day+1080);
    expect(state.systems.find(item=>item.id===setup.target.id)!.ownerId).toBe('aurora');
    expect(stateHash(await advanceRound(state,inline))).toBe(stateHash(await advanceRound(JSON.parse(JSON.stringify(state)),workers)));
  });
  it('准备取消不会生成成果，同轮撤回与重建拒绝', () => {
    const {state}=fixture();const stage=new StagingArea(state,'aurora');
    expect(stage.execute(prepare.type,prepare.args).ok).toBe(true);
    expect(stage.execute('cancel_conquest',{}).ok).toBe(false);
    expect(stage.draft.warAchievements).toEqual([]);
    const next=new StagingArea(stage.draft,'aurora');
    expect(next.execute('cancel_conquest',{}).ok).toBe(true);
    expect(next.execute(prepare.type,prepare.args).ok).toBe(false);
  });
  it('成熟资格因目标淘汰取消，准备期军事无额外倍率', () => {
    const {state}=fixture();const next=start(state);
    next.factions.umbra.eliminatedDay=0;updateEscalation(next,0);
    expect(conquestFor(next,'aurora')).toBeUndefined();
    expect(next.conquests![0].outcome).toBe('势力淘汰');
    expect(next.warAchievements).toEqual([]);
  });
  it('磁盘检查点与审计导出保留成熟资格、宿敌和成果，不重复授分', async () => {
    const directory=await mkdtemp(join(tmpdir(),'stars-escalation-'));
    try {
      const {state}=fixture();const next=start(state);
      next.day=360;updateEscalation(next);finishWar(next);
      awardAchievement(next,{actor:'aurora',target:'umbra',systemId:'s1',type:'limited',day:360,warId:next.wars![0].id});
      const store=new MatchStore(directory);
      const metrics=Object.fromEntries(Object.keys(next.factions).map(actor=>[actor,emptyMetrics()]));
      await store.initialize({version:4,state:next,lastDecisions:null,metrics});
      const restored=await store.load(next.id);
      expect(stateHash(restored.state)).toBe(stateHash(next));
      expect(await store.exportChronicle(next.id)).toContain('宿敌、征服准备与战争成果');
      expect(await store.exportChronicle(next.id)).toContain(next.conquests![0].id);
      const audit=await store.auditRecords(next.id);
      expect(audit[0].category).toBe('match.initial');
      expect(JSON.stringify(audit)).toContain('rulesRevision');
      expect(stateHash(await advanceRound(next,inline))).toBe(stateHash(await advanceRound(restored.state,workers)));
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('批量Schema支持准备与撤回', () => {
    expect(BATCH_SCHEMA.safeParse({orders:[prepare,{type:'cancel_conquest',args:{}}],summary:'公开准备并撤回'}).success).toBe(true);
  });
});
