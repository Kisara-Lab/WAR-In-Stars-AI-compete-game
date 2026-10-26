import { afterEach, describe, expect, it } from 'vitest';
import { cohesionBreakdown, policyWindow, sensorCoverage } from '../src/shared/civil.js';
import { DEFAULT_CONFIG, RULES, units } from '../src/shared/rules.js';
import type { Fleet, GameState, Structure } from '../src/shared/types.js';
import { relationKey } from '../src/shared/diplomacy.js';
import { StagingArea } from '../src/sim/actions.js';
import { migrateState, updateContacts } from '../src/sim/diplomacy.js';
import { advanceRound } from '../src/sim/engine.js';
import { observation, refreshIntel } from '../src/sim/intel.js';
import { processLocal } from '../src/sim/local.js';
import { stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);

const pools: SimulationPool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); });
const pool = (size = 0) => { const instance = new SimulationPool(size); pools.push(instance); return instance; };
const structures = (...types: Structure['type'][]): Structure[] => types.map((type, index) => ({ id: `building-${index}`, type }));
const fixture = () => createGame({ ...structuredClone(DEFAULT_CONFIG), controller: 'scripted' }, 'civil-test', '4.2');

describe('民生建设与人口加权', () => {
  it('数量上限包含预留，LRS跨行星共享星系限额；取消及拆除按价返还', () => {
    const state = fixture();
    state.factions.aurora.resources.minerals = units(10000);
    const home = state.systems[0];
    const planet = home.planets[0];
    const other = structuredClone(planet); other.id = 'second-colony'; other.structures = [];
    home.planets.push(other);
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'sanatorium' }).ok).toBe(true);
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'sanatorium' }).ok).toBe(false);
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'resort' }).ok).toBe(true);
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'resort' }).ok).toBe(true);
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'resort' }).ok).toBe(false);
    expect(stage.execute('build_structure', { planetId: planet.id, structureType: 'lrs' }).ok).toBe(true);
    expect(stage.execute('build_structure', { planetId: other.id, structureType: 'lrs' }).ok).toBe(false);
    const project = stage.draft.systems[0].projects.find(project => project.structureType === 'lrs')!;
    expect(project.requiredDays).toBe(400);
    const balance = stage.draft.factions.aurora.resources.minerals;
    stage.execute('cancel_order', { projectId: project.id });
    expect(stage.draft.factions.aurora.resources.minerals - balance).toBe(units(160));
    stage.draft.systems[0].planets[0].structures.push({ id: 'finished-lrs', type: 'lrs' });
    const beforeScrap = stage.draft.factions.aurora.resources.minerals;
    expect(stage.execute('scrap_structure', { planetId: planet.id, structureId: 'finished-lrs' }).ok).toBe(true);
    expect(stage.draft.factions.aurora.resources.minerals - beforeScrap).toBe(units(80));
    expect(state.systems[0].projects).toHaveLength(0);
  });

  it('低人口殖民地不能无成本堆叠民生，短缺及穷兵黩武惩罚完整叠加', () => {
    const state = fixture();
    const home = state.systems[0];
    home.planets[0].structures = structures('mine', 'mine', 'mine', 'mine', 'sanatorium', 'resort');
    const small = structuredClone(home.planets[0]); small.id = 'small'; small.population = 2; small.structures = structures('resort'); home.planets.push(small);
    expect(cohesionBreakdown(state, 'aurora').total).toBeCloseTo(1 + 2 * 10 / 12 + 4 * 2 / 12);
    state.factions.aurora.policy = { term: 0, choice: 'militarism', explicit: true, locked: true };
    state.factions.aurora.shortages = { energy: true, food: true, minerals: true };
    const result = cohesionBreakdown(state, 'aurora');
    expect(result.shortage).toBe(-30);
    expect(result.base).toBe(0);
    expect(result.policy).toBe(-4);
    expect(result.buildings).toBeCloseTo((6 * 0.125 - 4 * 1.5) * 10 / 12 + 4 * 0.125 * 2 / 12);
  });

  it('新设施占用正确槽位并按凝聚力完成建设', async () => {
    let state = fixture();
    state.factions.aurora.resources.minerals = units(5000);
    const stage = new StagingArea(state, 'aurora');
    for (const type of ['sanatorium', 'resort', 'lrs']) expect(stage.execute('build_structure', { planetId: 's0-p0', structureType: type }).ok).toBe(true);
    const executor = pool();
    state = await advanceRound(state, executor, { aurora: stage.actions });
    expect(state.systems[0].planets[0].structures).toHaveLength(5);
    for (let round = 0; round < 3; round++) state = await advanceRound(state, executor);
    expect(state.systems[0].planets[0].structures.map(structure => structure.type)).toEqual(expect.arrayContaining(['sanatorium', 'resort', 'lrs']));
  });
});

describe('720日任期与完整战力倍率', () => {
  it('多个星系同一步交战的审计结算顺序不受worker分区影响', async () => {
    const state = fixture();
    state.relations[relationKey('aurora', 'umbra')].status = 'war';
    for (const system of [state.systems[1], state.systems[2], state.systems[7]]) for (const ownerId of ['aurora', 'umbra']) {
      state.fleets.push({ id: `${system.id}-${ownerId}`, name: ownerId, ownerId, systemId: system.id, position: { x: 500, y: 500 }, transit: null, order: null, ships: [{ id: `${system.id}-${ownerId}-ship`, type: 'cruiser', hull: ownerId === 'aurora' ? 30 : 20 }] });
    }
    const inline = await advanceRound(state, pool());
    const parallel = await advanceRound(state, pool(4));
    expect(stateHash(inline)).toBe(stateHash(parallel));
    expect(inline.events.filter(event => event.type === 'battle').map(event => (event.details as { order: number }).order)).toEqual([1, 1, 1]);
  });

  it('跳过锁定，未提交默认跳过；第700日排定下一届，精确在720日切换', async () => {
    let state = fixture();
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('choose_policy', { policy: 'balanced' }).ok).toBe(true);
    expect(stage.execute('choose_policy', { policy: 'utopia' }).ok).toBe(false);
    const skip = new StagingArea(state, 'umbra');
    expect(skip.execute('choose_policy', { policy: 'none' }).ok).toBe(true);
    expect(skip.execute('choose_policy', { policy: 'balanced' }).ok).toBe(false);
    const executor = pool();
    const effects: string[] = [];
    const sink = async (batch: { economy: unknown[] }) => {
      for (const row of batch.economy as { factionId: string; multipliers: { policy: { choice: string } } }[]) if (row.factionId === 'aurora') effects.push(row.multipliers.policy.choice);
    };
    state = await advanceRound(state, executor, { aurora: stage.actions, umbra: skip.actions }, sink);
    expect(state.factions.verdant.policy).toMatchObject({ choice: 'none', explicit: false, locked: true });
    expect(state.factions.umbra.policy).toMatchObject({ choice: 'none', explicit: true, locked: true });
    expect(policyWindow(state, 'aurora')).toBeNull();
    for (let round = 1; round < 7; round++) state = await advanceRound(state, executor, {}, sink);
    expect(state.day).toBe(700);
    expect(policyWindow(state, 'aurora')).toBe(1);
    const next = new StagingArea(state, 'aurora');
    expect(next.execute('choose_policy', { policy: 'utopia' }).ok).toBe(true);
    expect(next.draft.factions.aurora.policy?.choice).toBe('balanced');
    state = await advanceRound(state, executor, { aurora: next.actions }, sink);
    expect(effects.filter(choice => choice === 'balanced')).toHaveLength(72);
    expect(effects.filter(choice => choice === 'utopia')).toHaveLength(8);
    expect(state.factions.aurora.policy).toMatchObject({ term: 1, choice: 'utopia', explicit: true });
    expect(state.events.some(event => event.type === 'policy' && event.day === 720)).toBe(true);
    const restored = structuredClone(state);
    for (let round = 8; round < 15; round++) state = await advanceRound(state, executor);
    expect(state.factions.aurora.policy).toMatchObject({ term: 2, choice: 'none', explicit: false });
    expect(restored.factions.aurora.policy?.choice).toBe('utopia');
  });

  it('战力增益用于舰队和基地，战损换算除以完整倍率', () => {
    const state = fixture();
    const system = state.systems[1]; system.base = null; system.ownerId = null;
    state.relations[relationKey('aurora', 'umbra')].status = 'war';
    state.factions.aurora.policy = { term: 0, choice: 'militarism', explicit: true, locked: true };
    const fleet = (id: string, count: number): Fleet => ({ id, name: id, ownerId: id, systemId: system.id, position: { x: 500, y: 500 }, transit: null, order: null, ships: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, type: 'destroyer', hull: 10 })) });
    const result = processLocal({ seed: 'battle', day: 10, phase: 'combat', systems: [system], fleets: [fleet('aurora', 10), fleet('umbra', 9)], factions: state.factions, relations: state.relations });
    expect(result.fleets).toHaveLength(1);
    expect(result.fleets[0].ships.reduce((sum, ship) => sum + ship.hull, 0)).toBeCloseTo(100 - 90 * 0.5 / 1.1, 2);
    expect((result.events.find(event => event.type === 'battle')!.details as { effectivePower: Record<string, number> }).effectivePower.aurora).toBeCloseTo(110);
    system.ownerId = 'aurora'; system.base = { hull: 40 };
    const baseResult = processLocal({ seed: 'base', day: 10, phase: 'combat', systems: [system], fleets: [fleet('umbra', 4)], factions: state.factions, relations: state.relations });
    expect(baseResult.systems[0].ownerId).toBe('aurora');
    expect(baseResult.systems[0].base!.hull).toBeCloseTo(40 - 20 / 1.1, 2);
  });

  it('政策产出倍率不修改维护，且不同worker结果一致', async () => {
    const state = fixture();
    const executor = pool(); const parallel = pool(2);
    const actions = { aurora: [{ type: 'choose_policy', args: { policy: 'militarism' } }] };
    const first = await advanceRound(state, executor, actions);
    const second = await advanceRound(state, parallel, actions);
    expect(stateHash(first)).toBe(stateHash(second));
    const home = structuredClone(state.systems[0]);
    const input = { seed: 'economy', day: 10, phase: 'economy' as const, systems: [home], fleets: [], factions: structuredClone(state.factions), relations: state.relations };
    const normal = processLocal(structuredClone(input));
    input.factions.aurora.policy = { term: 0, choice: 'militarism', explicit: true, locked: true };
    const war = processLocal(input);
    expect(war.income.aurora.minerals / normal.income.aurora.minerals).toBeCloseTo(1.35);
    expect(war.income.aurora.food / normal.income.aurora.food).toBeCloseTo(0.65);
    expect(war.upkeep).toEqual(normal.upkeep);
  });
});

function sensorFixture(): GameState {
  const state = fixture();
  for (const system of state.systems) { system.neighbors = []; }
  for (let index = 0; index < 4; index++) state.systems[index].neighbors = [index - 1, index + 1].filter(next => next >= 0 && next < 4).map(next => state.systems[next].id);
  state.systems[0].planets[0].structures.push({ id: 'sensor', type: 'lrs' });
  const target = state.systems[2]; target.ownerId = 'umbra'; target.base = { hull: 31 };
  target.planets[0].population = 13; target.planets[0].ownerId = 'umbra'; target.planets[0].structures = [{ id: 'secret-resort', type: 'resort' }];
  const enemy = state.fleets.find(fleet => fleet.ownerId === 'umbra')!;
  enemy.systemId = target.id; enemy.position = { x: 200, y: 300 }; enemy.order = { systemId: 's0', position: { x: 9, y: 9 }, route: ['s1', 's0'], targetFleetId: null };
  return state;
}

describe('LRS军事视野隔离', () => {
  it('覆盖本地至两跳，隐藏第三跳及经济；远程军事发现可以触发接触', () => {
    const state = sensorFixture();
    expect([...sensorCoverage(state, 'aurora')].sort()).toEqual(['s0', 's1', 's2']);
    refreshIntel(state); updateContacts(state);
    const view = observation(state, 'aurora');
    const remote = view.systems.find(system => system.id === 's2')!;
    expect(remote.intelligenceSource).toBe('lrs');
    expect(remote.base?.hull).toBe(31);
    expect(remote.planets).toBeNull();
    expect(remote.surveyed).toBe(false);
    expect(remote.fleets[0].ships).toHaveLength(3);
    expect(remote.fleets[0].order).toBeUndefined();
    expect(view.systems.find(system => system.id === 's3')!.visible).toBe(false);
    expect(JSON.stringify(view)).not.toContain('secret-resort');
    expect(state.relations[relationKey('aurora', 'umbra')].status).toBe('contact');
    expect(state.factions.aurora.intel.s2).toBeUndefined();
  });

  it('食物短缺不缩减覆盖，断电/维护/拆除/失去主权撤销覆盖并保留历史', () => {
    const state = sensorFixture(); state.day = 10;
    state.factions.aurora.shortages.food = true;
    expect(sensorCoverage(state, 'aurora').has('s2')).toBe(true);
    refreshIntel(state);
    for (const resource of ['energy', 'minerals'] as const) {
      state.factions.aurora.shortages[resource] = true; state.day = 20;
      refreshIntel(state);
      expect(sensorCoverage(state, 'aurora').size).toBe(0);
      expect(observation(state, 'aurora').systems.find(system => system.id === 's2')).toMatchObject({ intelligenceSource: 'last_known', lastSeenDay: 10 });
      state.factions.aurora.shortages[resource] = false;
    }
    state.systems[0].ownerId = 'umbra'; expect(sensorCoverage(state, 'aurora').size).toBe(0);
    state.systems[0].ownerId = 'aurora'; state.systems[0].planets[0].structures = [];
    expect(sensorCoverage(state, 'aurora').size).toBe(0);
  });

  it('在途仅两端覆盖时实时跟踪，离境冻结最后情报，外部进入后重新发现', () => {
    const state = sensorFixture();
    const enemy = state.fleets.find(fleet => fleet.ownerId === 'umbra')!;
    enemy.systemId = null; enemy.transit = { from: 's1', to: 's2', remainingDays: 20 };
    state.day = 10; refreshIntel(state);
    expect(state.factions.aurora.transitIntel?.[enemy.id].live).toBe(true);
    enemy.transit = { from: 's2', to: 's3', remainingDays: 25 }; enemy.departedDay = 20;
    state.day = 20; refreshIntel(state);
    expect(state.factions.aurora.transitIntel?.[enemy.id]).toMatchObject({ day: 20, live: false });
    state.day = 30; enemy.transit.remainingDays = 15; delete enemy.departedDay; refreshIntel(state);
    expect(state.factions.aurora.transitIntel?.[enemy.id].fleet.transit?.remainingDays).toBe(25);
    enemy.transit = { from: 's3', to: 's2', remainingDays: 20 }; refreshIntel(state);
    expect(state.factions.aurora.transitIntel?.[enemy.id].day).toBe(20);
    enemy.transit = null; enemy.systemId = 's2'; state.day = 60; refreshIntel(state);
    expect(state.factions.aurora.transitIntel?.[enemy.id]).toBeUndefined();
    expect(observation(state, 'aurora').systems.find(system => system.id === 's2')!.lastSeenDay).toBe(60);
  });

  it('版本2迁移保留旧数据，本届无政策并锁定，下届开放选择', () => {
    const state = fixture(); (state as { version: number }).version = 2; state.day = 700;
    const migrated = migrateState(state);
    expect(state.version).toBe(2);
    expect(migrated.version).toBe(4);
    expect(migrated.factions.aurora.policy).toMatchObject({ term: 0, choice: 'none', locked: true });
    expect(policyWindow(migrated, 'aurora')).toBe(1);
    expect(RULES.policyDays).toBe(720);
  });
});
