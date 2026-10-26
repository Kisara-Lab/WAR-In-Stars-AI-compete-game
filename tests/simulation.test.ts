import { afterAll, describe, expect, it } from 'vitest';
import { BASE, DEFAULT_CONFIG, RULES, SHIPS, units } from '../src/shared/rules.js';
import type { Fleet, GameState } from '../src/shared/types.js';
import { StagingArea } from '../src/sim/actions.js';
import { advanceRound, commitActions } from '../src/sim/engine.js';
import { observation, refreshIntel } from '../src/sim/intel.js';
import { processLocal } from '../src/sim/local.js';
import { distance, fleetPower, shortestPath, stateHash } from '../src/sim/math.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);

import { createRelations } from '../src/sim/diplomacy.js';

const inline = new SimulationPool(0);
afterAll(() => inline.close());
const game = () => {
  const state = createGame(structuredClone(DEFAULT_CONFIG), 'test-match', '4.2');
  return state;
};
const noActions = () => ({ aurora: [], umbra: [] });
const factors = (state: GameState) => state.factions;
const fixtureFleet = (ownerId: 'aurora' | 'umbra', count: number): Fleet => ({ id: ownerId, name: ownerId, ownerId, systemId: 's1', position: { x: 500, y: 500 }, order: null, transit: null, ships: Array.from({ length: count }, (_, index) => ({ id: `${ownerId}-${index}`, type: 'destroyer', hull: SHIPS.destroyer.power })) });

describe('地图和命令预留', () => {
  it('地图可复现、旋转对称且母星间隔至少三跳', () => {
    const state = game();
    expect(stateHash(state)).toBe(stateHash(game()));
    expect(shortestPath(state.systems, 's0', 's12')!.length).toBeGreaterThanOrEqual(3);
    state.systems.slice(0, 12).forEach((system, index) => {
      expect(system.position.x + state.systems[index + 12].position.x).toBeCloseTo(1000, 8);
      expect(system.position.y + state.systems[index + 12].position.y).toBeCloseTo(1000, 8);
      expect(system.planets.length).toBe(state.systems[index + 12].planets.length);
    });
    for (const count of [24, 32, 64, 128]) expect(createGame({ ...structuredClone(DEFAULT_CONFIG), systemCount: count }).systems).toHaveLength(count);
  });

  it('拒绝重复消费，失败命令不污染草稿，公共状态不提前变化', () => {
    const state = game();
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('queue_ships', { planetId: 's0-p0', shipType: 'destroyer', count: 10 }).ok).toBe(true);
    expect(stage.execute('queue_ships', { planetId: 's0-p0', shipType: 'destroyer', count: 1 }).ok).toBe(false);
    expect(stage.draft.factions.aurora.resources.minerals).toBe(0);
    expect(state.factions.aurora.resources.minerals).toBe(units(600));
    expect(stage.draft.systems[0].projects).toHaveLength(10);
  });

  it('预留槽位并限制船厂数量和非法参数', () => {
    const stage = new StagingArea(game(), 'aurora');
    stage.draft.factions.aurora.resources.minerals = units(10000);
    for (let index = 0; index < 5; index++) expect(stage.execute('build_structure', { planetId: 's0-p0', structureType: 'mine' }).ok).toBe(true);
    expect(stage.execute('build_structure', { planetId: 's0-p0', structureType: 'farm' }).ok).toBe(false);
    expect(stage.execute('build_structure', { planetId: 's0-p0', structureType: 'shipyard' }).ok).toBe(false);
    expect(stage.execute('queue_ships', { planetId: 's0-p0', shipType: 'destroyer', count: -1 }).ok).toBe(false);
    expect(stage.execute('build_structure', { planetId: 's12-p0', structureType: 'mine' }).ok).toBe(false);
  });

  it('取消项目返还一半费用，结束回合后拒绝命令', () => {
    const stage = new StagingArea(game(), 'aurora');
    stage.execute('build_structure', { planetId: 's0-p0', structureType: 'mine' });
    stage.execute('cancel_order', { projectId: stage.draft.systems[0].projects[0].id });
    expect(stage.draft.factions.aurora.resources.minerals).toBe(units(540));
    stage.execute('end_turn', { summary: '结束' });
    expect(stage.execute('survey_system', { systemId: 's1' }).ok).toBe(false);
  });

  it('同轮基地争建的裁决可复现且全额退款', () => {
    const state = game();
    const target = state.systems[1];
    target.neighbors.push('s0', 's6');
    state.factions.aurora.surveyed.push(target.id);
    state.factions.umbra.surveyed.push(target.id);
    const action = { type: 'build_starbase', args: { systemId: target.id } };
    const first = commitActions(state, { aurora: [action], umbra: [action] });
    expect(first.systems[1].projects).toHaveLength(1);
    expect(first.factions.aurora.resources.minerals + first.factions.umbra.resources.minerals).toBe(units(1000));
    expect(stateHash(first)).toBe(stateHash(commitActions(state, { aurora: [action], umbra: [action] })));
  });

  it('后续回合不能通过争建抢走已经开始施工的基地项目', () => {
    const state = game();
    state.systems[1].neighbors.push('s0');
    state.factions.aurora.surveyed.push('s1');
    const first = new StagingArea(state, 'aurora');
    first.execute('build_starbase', { systemId: 's1' });
    first.draft.day = 100;
    first.draft.systems[1].neighbors.push('s6');
    first.draft.factions.umbra.surveyed.push('s1');
    const second = new StagingArea(first.draft, 'umbra');
    expect(second.execute('build_starbase', { systemId: 's1' }).ok).toBe(false);
  });

  it('拆分与合并保持舰船唯一性，合并拒绝跨位置舰队', () => {
    const stage = new StagingArea(game(), 'aurora');
    expect(stage.execute('split_fleet', { fleetId: 'aurora-initial', count: 1 }).ok).toBe(true);
    const detached = stage.draft.fleets.find(fleet => fleet.ownerId === 'aurora' && fleet.id !== 'aurora-initial')!;
    const detachedId = detached.id;
    detached.position.x += 30;
    expect(stage.execute('merge_fleets', { fleetIds: ['aurora-initial', detachedId] }).ok).toBe(false);
    stage.draft.fleets.find(fleet => fleet.id === detachedId)!.position.x -= 30;
    expect(stage.execute('merge_fleets', { fleetIds: ['aurora-initial', detachedId] }).ok).toBe(true);
    const ships = stage.draft.fleets.filter(fleet => fleet.ownerId === 'aurora').flatMap(fleet => fleet.ships);
    expect(ships).toHaveLength(3);
    expect(new Set(ships.map(ship => ship.id)).size).toBe(3);
  });
});

describe('时间、经济与情报', () => {
  it('探索和殖民恰好跨500天完成', async () => {
    let state = game();
    const stage = new StagingArea(state, 'aurora');
    stage.draft.systems[1].neighbors.push('s0');
    state.systems[1].neighbors.push('s0');
    stage.execute('survey_system', { systemId: 's1' });
    stage.execute('colonize_planet', { planetId: 's0-p1' });
    state = await advanceRound(state, inline, { aurora: stage.actions, umbra: [] });
    for (let round = 1; round < 4; round++) state = await advanceRound(state, inline);
    expect(state.factions.aurora.surveyed).not.toContain('s1');
    expect(state.systems[0].planets[1].population).toBe(0);
    state = await advanceRound(state, inline);
    expect(state.day).toBe(500);
    expect(state.factions.aurora.surveyed).toContain('s1');
    expect(state.systems[0].planets[1].population).toBe(2);
  });

  it('三种短缺乘算且本步新短缺到下一步才影响生产', async () => {
    const state = game();
    state.factions.aurora.shortages = { energy: true, food: true, minerals: true };
    state.factions.aurora.unity = 5000;
    const output = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'economy', day: 10, systems: structuredClone([state.systems[0]]), fleets: [], factions: factors(state) });
    expect(output.income.aurora.minerals).toBe(units(120 * 0.125 * 0.1));
    const depleted = game();
    depleted.factions.aurora.resources.food = 0;
    depleted.systems[0].planets[0].structures = depleted.systems[0].planets[0].structures.filter(structure => structure.type !== 'farm');
    const advanced = await advanceRound(depleted, inline);
    expect(advanced.factions.aurora.shortages.food).toBe(true);
    expect(advanced.factions.aurora.unity).toBeLessThan(6000);
    expect(advanced.factions.aurora.resources.food).toBe(0);
    expect(advanced.factions.aurora.resources.minerals).toBeGreaterThan(depleted.factions.aurora.resources.minerals);
  });

  it('隐藏未探索行星与敌方实时舰队，情报保留最后时间戳', () => {
    const state = game();
    let view = observation(state, 'aurora');
    expect(view.systems.find(system => system.id === 's12')!.planets).toBeNull();
    expect(view.systems.find(system => system.id === 's12')!.fleets).toEqual([]);
    const scout = fixtureFleet('aurora', 1);
    scout.id = 'scout'; scout.systemId = 's12';
    state.fleets.push(scout);
    refreshIntel(state);
    view = observation(state, 'aurora');
    expect(view.systems.find(system => system.id === 's12')!.fleets.length).toBeGreaterThan(1);
    state.fleets = state.fleets.filter(fleet => fleet.id !== 'scout');
    state.day = 100;
    view = observation(state, 'aurora');
    expect(view.systems.find(system => system.id === 's12')!.lastSeenDay).toBe(0);
    expect(view.systems.find(system => system.id === 's12')!.visible).toBe(false);
    const previous = JSON.stringify(view);
    state.factions.umbra.shortages = { energy: true, food: true, minerals: true };
    expect(JSON.stringify(observation(state, 'aurora'))).toBe(previous);
  });

  it('船厂串行生产，维修按实际修复量扣矿物', async () => {
    const state = game();
    const stage = new StagingArea(state, 'aurora');
    stage.execute('queue_ships', { planetId: 's0-p0', shipType: 'destroyer', count: 3 });
    const built = await advanceRound(state, inline, { aurora: stage.actions, umbra: [] });
    expect(built.fleets.find(fleet => fleet.id === 'aurora-initial')!.ships).toHaveLength(4);
    expect(built.systems[0].projects.filter(project => project.kind === 'ship')).toHaveLength(2);
    const damaged = game();
    damaged.fleets[0].position = { x: 500, y: 500 };
    damaged.fleets[0].ships[0].hull = 5;
    const control = structuredClone(damaged);
    control.fleets[0].ships[0].hull = 10;
    const [repaired, full] = await Promise.all([advanceRound(damaged, inline), advanceRound(control, inline)]);
    expect(repaired.fleets[0].ships[0].hull).toBe(6);
    expect(full.factions.aurora.resources.minerals - repaired.factions.aurora.resources.minerals).toBe(units(3));
  });
});

describe('移动与战斗', () => {
  it('追击位于其他可见星系的目标时不会提前丢弃目标ID', () => {
    const state = game();
    const fleet = state.fleets[0];
    fleet.order = { systemId: state.systems[0].neighbors[0], position: { x: 100, y: 100 }, targetFleetId: 'remote-target', route: [state.systems[0].neighbors[0]] };
    const output = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'advance', day: 10, systems: [state.systems[0]], fleets: [fleet], factions: factors(state) });
    expect(output.fleets[0].order!.targetFleetId).toBe('remote-target');
  });
  it('强者必胜并承受确定战损，同战力双方全毁', () => {
    const state = game();
    const system = structuredClone(state.systems[1]);
    const result = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'combat', day: 10, systems: [system], fleets: [fixtureFleet('aurora', 10), fixtureFleet('umbra', 4)], factions: factors(state) });
    expect(result.fleets).toHaveLength(1);
    expect(result.fleets[0].ownerId).toBe('aurora');
    expect(fleetPower(result.fleets[0])).toBe(80);
    expect(result.fleets[0].ships).toHaveLength(8);
    const tied = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'combat', day: 10, systems: [system], fleets: [fixtureFleet('aurora', 4), fixtureFleet('umbra', 4)], factions: factors(state) });
    expect(tied.fleets).toHaveLength(0);
  });

  it('战斗检测覆盖同一步内交错穿越的舰队', () => {
    const state = game();
    const first = fixtureFleet('aurora', 10);
    const second = fixtureFleet('umbra', 4);
    first.previousPosition = { x: 100, y: 500 }; first.position = { x: 900, y: 500 };
    second.previousPosition = { x: 900, y: 500 }; second.position = { x: 100, y: 500 };
    const output = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'combat', day: 10, systems: [state.systems[1]], fleets: [first, second], factions: factors(state) });
    expect(output.events.some(event => event.type === 'battle')).toBe(true);
  });

  it('攻占基地移交人口设施并取消原主项目', () => {
    const state = game();
    const system = structuredClone(state.systems[12]);
    const fleet = fixtureFleet('aurora', 10);
    fleet.systemId = system.id;
    const stage = new StagingArea(state, 'umbra');
    stage.execute('build_structure', { planetId: 's12-p0', structureType: 'mine' });
    system.projects = stage.draft.systems[12].projects;
    const output = processLocal({ seed: state.config.seed, relations: createRelations(Object.keys(state.factions), true), phase: 'combat', day: 10, systems: [system], fleets: [fleet], factions: factors(state) });
    expect(output.systems[0].ownerId).toBe('aurora');
    expect(output.systems[0].planets[0].population).toBe(10);
    expect(output.systems[0].planets[0].structures.length).toBe(5);
    expect(output.systems[0].base!.hull).toBe(BASE.power / 2);
    expect(output.systems[0].projects).toEqual([]);
  });

  it('跨星系移动经过航道并最终到达指定坐标', async () => {
    let state = game();
    const stage = new StagingArea(state, 'aurora');
    expect(stage.execute('move_fleet', { fleetId: 'aurora-initial', systemId: 's2', x: 400, y: 400, targetFleetId: null }).ok).toBe(true);
    state = await advanceRound(state, inline, { aurora: stage.actions, umbra: [] });
    for (let round = 0; round < 3; round++) state = await advanceRound(state, inline);
    const fleet = state.fleets.find(candidate => candidate.id === 'aurora-initial')!;
    expect(fleet.systemId).toBe('s2');
    expect(fleet.position).toEqual({ x: 400, y: 400 });
    expect(fleet.order).toBeNull();
  });

  it('航道恰好耗时30日，抵达后不会重复获得本步移动时间', async () => {
    const state = game();
    const fleet = state.fleets[0];
    fleet.ships = [{ id: 'slow', type: 'dreadnought', hull: SHIPS.dreadnought.power }];
    const destination = state.systems.find(system => system.id === state.systems[0].neighbors[0])!;
    fleet.position = { ...state.systems[0].gates[destination.id] };
    const gate = destination.gates.s0;
    const x = gate.x < 500 ? 1000 : 0;
    const y = gate.y < 500 ? 1000 : 0;
    const stage = new StagingArea(state, 'aurora');
    stage.execute('move_fleet', { fleetId: fleet.id, systemId: destination.id, x, y, targetFleetId: null });
    const moved = await advanceRound(state, inline, { aurora: stage.actions, umbra: [] });
    const arrival = moved.events.find(event => event.type === 'movement' && event.text.includes('抵达'));
    expect(arrival?.day).toBe(30);
    expect(distance(moved.fleets.find(candidate => candidate.id === fleet.id)!.position, gate)).toBeCloseTo(70 * SHIPS.dreadnought.speed, 5);
  });
});

describe('并行一致性与完整结局', () => {
  it('0、1、4 worker 的逐轮状态哈希完全一致', async () => {
    const pools = [inline, new SimulationPool(1), new SimulationPool(4)];
    try {
      const results = await Promise.all(pools.map(async pool => {
        let state = game();
        const stage = new StagingArea(state, 'aurora');
        stage.execute('survey_system', { systemId: 's1' });
        stage.execute('queue_ships', { planetId: 's0-p0', shipType: 'destroyer', count: 3 });
        const hashes: string[] = [];
        for (let round = 0; round < 6; round++) {
          state = await advanceRound(state, pool, round === 0 ? { aurora: stage.actions, umbra: [] } : noActions());
          hashes.push(stateHash(state));
        }
        return hashes;
      }));
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(pools[2].metrics.every(metric => metric.tasks > 0 && metric.threadId > 0)).toBe(true);
    } finally { await pools[1].close(); await pools[2].close(); }
  }, 30000);

  it('轮数上限评分结束，结束后拒绝继续推进', async () => {
    const state = game(); state.config.maxRounds = 1;
    const finished = await advanceRound(state, inline);
    expect(finished.result?.reason).toBe('score');
    expect(finished.result?.winner).toBeNull();
    expect(finished.round).toBe(1);
    await expect(advanceRound(finished, inline)).rejects.toThrow('比赛已经结束');
  });
});
