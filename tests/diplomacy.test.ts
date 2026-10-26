import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, FACTION_PRESETS, RULES, factionIds, factionRecord } from '../src/shared/rules.js';
import type { Fleet, GameState } from '../src/shared/types.js';
import { canEnter, relationship } from '../src/shared/diplomacy.js';
import { applyAction, StagingArea, BATCH_SCHEMA } from '../src/sim/actions.js';
import { applyDiplomacy, createRelations, migrateState, updateContacts, updateDiplomacy } from '../src/sim/diplomacy.js';
import { advanceRound, commitActions } from '../src/sim/engine.js';
import { observation } from '../src/sim/intel.js';
import { processLocal } from '../src/sim/local.js';
import { distance, fleetPower, shortestPath, stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { emptyMetrics } from '../src/sim/bot.js';
import { MatchStore } from '../src/server/storage.js';
import { MatchRunner } from '../src/server/runner.js';

const pool = new SimulationPool(0);
afterAll(() => pool.close());
const game = () => createGame(structuredClone(DEFAULT_CONFIG), 'diplomacy-test');
const totalArgs = (target: string) => ({ factionId: target, warType: 'total', systemIds: [], reason: '已有重大理由', grievanceId: 'test-total' });
const allowTotal = (state: GameState, actor: string, target: string) => state.grievances!.push({ id: 'test-total', actor, target, kind: 'territory', active: true, expiresDay: 999999, source: 'test' });
const act = (state: GameState, actor: string, type: string, target = 'umbra') => {
  if (type === 'declare_war') { allowTotal(state, actor, target); return applyAction(state, actor, { type, args: totalArgs(target) }, 'test-declaration'); }
  return applyDiplomacy(state, actor, { type, args: { factionId: target } });
};
const pair = (state: GameState) => relationship(state, 'aurora', 'umbra')!;
const peace = (state: GameState) => { pair(state).status = 'peace'; pair(state).confirmed = ['aurora', 'umbra']; };
const fleet = (ownerId: string, count = 4, systemId = 's1'): Fleet => ({ id: `${ownerId}-test`, name: ownerId, ownerId, systemId, position: { x: 500, y: 500 }, transit: null, order: null, ships: Array.from({ length: count }, (_, index) => ({ id: `${ownerId}-${index}`, type: 'destroyer', hull: 10 })) });

describe('空间网络与多方开局', () => {
  it.each([4, 5, 6, 7, 8])('%i方多种种子均有对称起点、内部星系、回路和多出口', count => {
    const ids = FACTION_PRESETS.slice(0, count).map(preset => preset.id);
    for (let seed = 0; seed < 10; seed++) {
      const state = createGame({ ...DEFAULT_CONFIG, factionIds: ids, models: factionRecord(ids, () => 'grok-4.7'), systemCount: count * 6, seed: `mesh-test-${seed}` });
      expect(factionIds(state)).toHaveLength(count);
      expect(Object.values(state.relations)).toHaveLength(count * (count - 1) / 2);
      expect(state.systems.some(system => distance(system.position, { x: 500, y: 500 }) < 240)).toBe(true);
      const homes = Object.values(state.factions).map(faction => faction.homeSystemId);
      for (const home of homes) {
        const nearest = Math.min(...homes.filter(other => other !== home).map(other => shortestPath(state.systems, home, other)!.length));
        expect(nearest).toBeGreaterThanOrEqual(3); expect(nearest).toBeLessThanOrEqual(4);
      }
      expect(new Set(homes.map(home => state.systems.find(system => system.id === home)!.neighbors.length)).size).toBe(1);
      for (const system of state.systems) {
        expect(shortestPath(state.systems, homes[0], system.id)).not.toBeNull();
        for (const neighbor of system.neighbors) if (system.id < neighbor) {
          const removed = state.systems.map(candidate => ({ ...candidate, neighbors: candidate.neighbors.filter(id => !(candidate.id === system.id && id === neighbor || candidate.id === neighbor && id === system.id)) }));
          expect(shortestPath(removed, system.id, neighbor)).not.toBeNull();
        }
      }
    }
  });
  it('拒绝不足四方、非整倍数星系及不足六星系每方的配置', () => {
    expect(() => createGame({ ...DEFAULT_CONFIG, factionIds: ['aurora', 'umbra'] })).toThrow();
    expect(() => createGame({ ...DEFAULT_CONFIG, systemCount: 26 })).toThrow();
    expect(() => createGame({ ...DEFAULT_CONFIG, systemCount: 20 })).toThrow();
  });
});

describe('首次接触、战争与条约', () => {
  it('地图拓扑不触发接触，实际发现才创建事件且不会暴露给第三方', () => {
    const state = game(); updateContacts(state);
    expect(pair(state).status).toBe('unknown');
    state.fleets.push(fleet('aurora', 2, state.factions.umbra.homeSystemId)); updateContacts(state);
    expect(pair(state).status).toBe('contact');
    expect(observation(state, 'verdant').events.some(event => event.type === 'diplomacy')).toBe(false);
    expect(Object.values(observation(state, 'verdant').relations).some(relation => relation.factions.includes('aurora') && relation.factions.includes('umbra'))).toBe(false);
  });
  it('双方可以跨轮确认，和平与通行分别决定', () => {
    const state = game(); pair(state).status = 'contact';
    act(state, 'aurora', 'confirm_contact'); expect(pair(state).status).toBe('contact');
    state.round++; act(state, 'umbra', 'confirm_contact', 'aurora');
    expect(pair(state).status).toBe('peace'); expect(canEnter(state, 'umbra', 'aurora')).toBe(false);
    act(state, 'aurora', 'open_borders');
    expect(canEnter(state, 'umbra', 'aurora')).toBe(true); expect(canEnter(state, 'aurora', 'umbra')).toBe(false);
  });
  it('探索发现基地也会建立首次接触，旧情报不制造新发现', () => {
    const state = game();
    const home = state.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    state.day = 500;
    state.factions.aurora.intel[home.id] = { day: 490, system: structuredClone(home), fleets: [] };
    updateContacts(state); expect(pair(state).status).toBe('unknown');
    state.factions.aurora.intel[home.id].day = 500;
    updateContacts(state); expect(pair(state).status).toBe('contact');
  });
  it('同一轮双方确认不依赖提交对象顺序', () => {
    const state = game(); pair(state).status = 'contact';
    const first = { type: 'confirm_contact', args: { factionId: 'umbra' } };
    const second = { type: 'confirm_contact', args: { factionId: 'aurora' } };
    const result = commitActions(state, { aurora: [first], umbra: [second] });
    expect(pair(result).status).toBe('peace'); expect(pair(state).status).toBe('contact');
    expect(stateHash(result)).toBe(stateHash(commitActions(state, { umbra: [second], aurora: [first] })));
  });
  it('接触期实际交火转战争，第三方关系保持不变', async () => {
    const state = game(); state.fleets.push(fleet('aurora', 10), fleet('umbra', 4));
    const next = await advanceRound(state, pool);
    expect(pair(next).status).toBe('war'); expect(next.fleets.some(candidate => candidate.id === 'umbra-test')).toBe(false);
    expect(relationship(next, 'aurora', 'verdant')!.status).toBe('unknown');
    expect(next.events.some(event => event.text.includes('首次接触冲突'))).toBe(true);
  });
  it('和平同场不自动交火，必须先宣战且可在同轮进攻', async () => {
    const state = game(); peace(state); pair(state).access = { aurora: true, umbra: true };
    state.fleets.push(fleet('aurora', 10), fleet('umbra', 4));
    const peaceful = await advanceRound(state, pool);
    expect(peaceful.fleets.some(candidate => candidate.id === 'umbra-test')).toBe(true);
    const stage = new StagingArea(state, 'aurora');
    const order = { fleetId: 'aurora-test', systemId: 's1', x: null, y: null, targetFleetId: 'umbra-test' };
    expect(stage.execute('move_fleet', order).ok).toBe(false);
    allowTotal(stage.draft, 'aurora', 'umbra'); allowTotal(state, 'aurora', 'umbra');
    expect(stage.execute('declare_war', totalArgs('umbra')).ok).toBe(true);
    expect(stage.execute('move_fleet', order).ok).toBe(true);
    const war = await advanceRound(state, pool, { aurora: stage.actions });
    expect(pair(war).status).toBe('war'); expect(war.fleets.some(candidate => candidate.id === 'umbra-test')).toBe(false);
  });
  it('停战需次轮接受，谈判不自动停火，条约精确持续1080日', () => {
    const state = game(); pair(state).status = 'war';
    act(state, 'aurora', 'propose_peace');
    expect(() => act(state, 'umbra', 'accept_peace', 'aurora')).toThrow('上一轮');
    expect(pair(state).status).toBe('war');
    state.round++; state.day = 100; act(state, 'umbra', 'accept_peace', 'aurora');
    expect(pair(state).pactUntil).toBe(1180); expect(pair(state).status).toBe('peace');
    state.day = 1170; updateDiplomacy(state); expect(() => act(state, 'aurora', 'declare_war')).toThrow();
    state.day = 1180; updateDiplomacy(state); expect(pair(state).status).toBe('peace');
    act(state, 'aurora', 'declare_war'); expect(pair(state).status).toBe('war');
  });
  it('互提停战不自动接受，支持拒绝、撤回和到期', () => {
    const state = game(); pair(state).status = 'war';
    act(state, 'aurora', 'propose_peace'); act(state, 'umbra', 'propose_peace', 'aurora');
    expect(pair(state).status).toBe('war'); state.round++;
    act(state, 'umbra', 'reject_peace', 'aurora'); expect(pair(state).offers.aurora).toBeUndefined();
    act(state, 'umbra', 'withdraw_peace', 'aurora'); expect(pair(state).offers).toEqual({});
    act(state, 'aurora', 'propose_peace'); state.day = RULES.peaceOfferDays; updateDiplomacy(state);
    expect(pair(state).offers).toEqual({}); expect(() => act(state, 'umbra', 'accept_peace', 'aurora')).toThrow();
  });
  it('拒绝重复外交指令，接受与撤回冲突时确定性撤回优先', () => {
    const state = game(); peace(state);
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('open_borders', { factionId: 'umbra' }).ok).toBe(true);
    expect(stage.execute('close_borders', { factionId: 'umbra' }).ok).toBe(false);
    pair(state).status = 'war'; act(state, 'aurora', 'propose_peace'); state.round++;
    const next = commitActions(state, { umbra: [{ type: 'accept_peace', args: { factionId: 'aurora' } }], aurora: [{ type: 'withdraw_peace', args: { factionId: 'umbra' } }] });
    expect(pair(next).status).toBe('war'); expect(next.events.some(event => event.text.includes('结算冲突'))).toBe(true);
    expect(BATCH_SCHEMA.safeParse({ orders: [{ type: 'declare_war', args: totalArgs('umbra') }], summary: '宣战' }).success).toBe(true);
  });
});

describe('闭境与撤离', () => {
  it('停战清除攻击目标，境内舰队自动撤离且不能拆分规避', async () => {
    const state = game(); pair(state).status = 'war';
    const intruder = fleet('aurora', 10, state.factions.umbra.homeSystemId); intruder.position = { x: 800, y: 800 }; state.fleets.push(intruder);
    intruder.order = { systemId: state.factions.umbra.homeSystemId, position: { x: 500, y: 500 }, route: [], targetFleetId: 'umbra-initial' };
    act(state, 'aurora', 'propose_peace'); state.round++;
    const next = await advanceRound(state, pool, { umbra: [{ type: 'accept_peace', args: { factionId: 'aurora' } }] });
    expect(pair(next).status).toBe('peace'); expect(next.events.some(event => event.type === 'battle')).toBe(false);
    expect(next.fleets.find(candidate => candidate.id === intruder.id)?.order?.targetFleetId).toBeFalsy();
    peace(state); updateDiplomacy(state);
    expect(intruder.withdrawal).toBeDefined();
    const stage = new StagingArea(state, 'aurora'); expect(stage.execute('split_fleet', { fleetId: intruder.id, count: 1 }).ok).toBe(false);
  });
  it('在途舰队抵达后遵守关闭边境，原舰船和资源不因撤离增加', async () => {
    const state = game(); peace(state);
    const target = state.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    const traveler = state.fleets[0]; const ships = structuredClone(traveler.ships);
    traveler.systemId = null; traveler.transit = { from: target.neighbors[0], to: target.id, remainingDays: 10 };
    const next = await advanceRound(state, pool); const moved = next.fleets.find(candidate => candidate.id === traveler.id)!;
    expect(moved.ships).toEqual(ships); expect(next.events.some(event => event.text.includes('撤出'))).toBe(true);
  });
  it('无路可退时执行100日紧急撤离；期限到达才返回基地', () => {
    const state = game(); peace(state);
    const target = state.systems.find(system => system.id === state.factions.umbra.homeSystemId)!;
    target.neighbors = [];
    const intruder = fleet('aurora', 2, target.id); state.fleets.push(intruder);
    const resources = structuredClone(state.factions.aurora.resources);
    updateDiplomacy(state); expect(intruder.systemId).toBeNull(); expect(intruder.withdrawal?.emergencyUntil).toBe(100);
    state.day = 90; updateDiplomacy(state); expect(intruder.systemId).toBeNull();
    state.day = 100; updateDiplomacy(state); expect(intruder.systemId).toBe(state.factions.aurora.homeSystemId);
    expect(intruder.ships).toHaveLength(2); expect(state.factions.aurora.resources).toEqual(resources);
  });
  it('撤离宽限期和领土易主都触发正确处理', () => {
    const state = game(); peace(state); const intruder = fleet('aurora', 2, 's1'); state.fleets.push(intruder);
    const target = state.systems[1]; target.ownerId = 'umbra'; target.base = { hull: 40 };
    updateDiplomacy(state); expect(intruder.withdrawal?.deadline).toBe(300);
    state.day = 300; updateDiplomacy(state); expect(intruder.withdrawal?.emergencyUntil).toBe(400);
  });
  it('被多层闭境领土包围时沿领土内通路撤离，不提前紧急跳跃', () => {
    const state = game(); peace(state);
    const inner = state.systems[1]; const outer = state.systems[2]; const exit = state.systems[3];
    inner.ownerId = 'umbra'; outer.ownerId = 'umbra'; inner.neighbors = [outer.id]; outer.neighbors = [inner.id, exit.id];
    const intruder = fleet('aurora', 2, inner.id); state.fleets.push(intruder); updateDiplomacy(state);
    expect(intruder.withdrawal?.emergencyUntil).toBeNull(); expect(intruder.order?.route).toEqual([outer.id, exit.id]);
  });
});

describe('多方混战与复现', () => {
  it('中立第三方不合兵且不受伤，基地不被和平势力夺取', () => {
    const state = game(); pair(state).status = 'war';
    const system = structuredClone(state.systems[1]); system.ownerId = 'verdant'; system.base = { hull: 40 };
    const output = processLocal({ seed: state.config.seed, relations: state.relations, phase: 'combat', day: 10, systems: [system], fleets: [fleet('aurora', 10), fleet('umbra', 4), fleet('verdant', 20)], factions: state.factions });
    expect(output.fleets.find(candidate => candidate.ownerId === 'umbra')).toBeUndefined();
    expect(fleetPower(output.fleets.find(candidate => candidate.ownerId === 'aurora')!)).toBe(80);
    expect(fleetPower(output.fleets.find(candidate => candidate.ownerId === 'verdant')!)).toBe(200);
    expect(system.ownerId).toBe('verdant'); expect(system.base.hull).toBe(40);
  });
  it('三方敌对混战跨worker和存档恢复逐轮哈希一致', async () => {
    const state = game(); state.relations = createRelations(factionIds(state), true);
    state.fleets.push(fleet('aurora', 20), fleet('umbra', 10), fleet('verdant', 8));
    const threaded = new SimulationPool(4);
    try {
      const serial = await advanceRound(state, pool); const parallel = await advanceRound(state, threaded);
      expect(stateHash(serial)).toBe(stateHash(parallel));
      expect(stateHash(await advanceRound(JSON.parse(JSON.stringify(serial)), pool))).toBe(stateHash(await advanceRound(parallel, threaded)));
    } finally { await threaded.close(); }
  });
  it('淘汰一方后继续多方比赛，清理其舰队和项目', async () => {
    const state = game(); const home = state.systems.find(system => system.ownerId === 'umbra')!; home.ownerId = null; home.base = null; home.planets.forEach(planet => { planet.ownerId = null; });
    const next = await advanceRound(state, pool);
    expect(next.factions.umbra.eliminatedDay).toBe(10); expect(next.fleets.some(candidate => candidate.ownerId === 'umbra')).toBe(false); expect(next.result).toBeNull();
  });
  it('旧版哈希先验证，普通恢复不升级，显式V5分支保留原档', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stars-legacy-'));
    const original = game();
    const raw = JSON.parse(JSON.stringify(original)); raw.version = 1; delete raw.relations; delete raw.config.factionIds;
    for (const id of ['verdant', 'cobalt']) { delete raw.factions[id]; delete raw.config.models[id]; }
    raw.fleets = raw.fleets.filter((candidate: Fleet) => ['aurora', 'umbra'].includes(candidate.ownerId));
    const store = new MatchStore(directory);
    const runner = new MatchRunner(game(), new SimulationPool(0), store, async () => { throw new Error('不应请求模型'); });
    try {
      await store.initialize({ version: 1, state: raw, lastDecisions: null, metrics: factionRecord(['aurora', 'umbra'], emptyMetrics) });
      const file = join(directory, raw.id, 'checkpoint.json'); const before = await readFile(file, 'utf8');
      const loaded = await store.load(raw.id); expect(loaded.hash).toBe(stateHash(raw)); expect((loaded.state.version as number)).toBe(1);
      const migrated = migrateState(loaded.state); expect(migrated.version).toBe(4); expect(pair(migrated).status).toBe('war'); const withoutCandidates = (systems: GameState['systems']) => systems.map(system => ({ ...system, planets: system.planets.map(({ holyCandidate: _candidate, ...planet }) => planet) })); expect(withoutCandidates(migrated.systems)).toEqual(withoutCandidates(raw.systems));
      await runner.load(raw.id); expect(runner.state.id).not.toBe(raw.id); expect(runner.state.version as number).toBe(1); expect(runner.state.rulesRevision).toBe(raw.rulesRevision);
      await runner.load(raw.id,undefined,'5.0'); expect(runner.state.version).toBe(5); expect(runner.state.config.legacy).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally { await runner.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
