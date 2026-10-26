import { afterAll, describe, expect, it } from 'vitest';
import { BALANCE, annexationFactor, civilizationScore, holyCooperation, warBurden } from '../src/shared/balance.js';
import { cohesionBreakdown, currentPolicy } from '../src/shared/civil.js';
import { policyComparison } from '../src/shared/comparison.js';
import { DEFAULT_CONFIG, RULES, units } from '../src/shared/rules.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { viewpoint } from '../src/shared/viewpoint.js';
import { controller } from '../src/shared/v4.js';
import { awardCivilization, finishBalanceInterval, migrateBalance } from '../src/sim/balance.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { decisionComparison } from '../src/sim/options.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { cedeSystem, createWar, declareWar, settleWar } from '../src/sim/wars.js';
import { processLocal } from '../src/sim/local.js';
import type { FactionFactors, LocalInput } from '../src/sim/local.js';
import { trackBeacon } from '../src/sim/religion.js';
import { StagingArea } from '../src/sim/actions.js';
import { observation } from '../src/sim/intel.js';

const pools = [0, 2, 8].map(size => new SimulationPool(size));
afterAll(async () => { await Promise.all(pools.map(pool => pool.close())); });
function fixture() {
  const state = createGame(structuredClone(DEFAULT_CONFIG), 'balance-fixture', '4.2');
  for (const faction of Object.values(state.factions)) faction.resources = { energy: units(100000), food: units(100000), minerals: units(100000) };
  return state;
}
function faith(state: ReturnType<typeof fixture>) {
  const faction = state.factions.aurora;
  faction.faith = { name: '测试信仰', doctrine: '测试场景', establishedDay: 0, crisis: 0, sites: [{ main: true, planetId: state.systems[0].planets[0].id, consecratedDay: 0, lossKeys: [], recoveryKeys: [] }], lossWindow: 0, lossUsed: 0, pending: [], triggers: {} };
  return faction.faith;
}
function local(state: ReturnType<typeof fixture>, phase: LocalInput['phase'] = 'economy') {
  return processLocal({ phase, day: state.day + 10, seed: state.config.seed, systems: structuredClone(state.systems), fleets: structuredClone(state.fleets), relations: state.relations, factions: Object.fromEntries(Object.entries(state.factions).map(([id, faction]) => [id, { ...faction, balance: state.rulesRevision === '4.2', warUpkeep: warBurden(state, id).multiplier, populationGrowth: faction.policy?.choice === 'utopia' ? BALANCE.utopiaGrowth : 1, policyEffects: currentPolicy(state, id) }])) });
}
describe('4.2 战争开支与吞并整合', () => {
  it('同轮有限目标不误算为主动总体战，双方声明总体战均主动', () => {
    const state = fixture();
    declareWar(state, 'aurora', 'umbra', 'limited', [state.factions.umbra.homeSystemId], '合成目标');
    declareWar(state, 'umbra', 'aurora', 'total', [], '合成理由');
    expect(warBurden(state, 'aurora')).toMatchObject({ offensive: 0, defensive: 1 });
    expect(warBurden(state, 'umbra').offensive).toBe(1);
    const other = fixture();
    declareWar(other, 'aurora', 'umbra', 'total', [], '合成理由');
    declareWar(other, 'umbra', 'aurora', 'total', [], '合成理由');
    expect(warBurden(other, 'aurora').offensive).toBe(1);
    expect(warBurden(other, 'umbra').offensive).toBe(1);
  });
  it('主动、防御、多线及60%上限；战争结束解除，旧修订无加价', () => {
    const state = fixture();
    const first = createWar(state, ['aurora', 'umbra'], 'total'); first.attackers = ['aurora'];
    expect(warBurden(state, 'aurora').multiplier).toBe(1.25);
    expect(warBurden(state, 'umbra').multiplier).toBe(1.1);
    const second = createWar(state, ['aurora', 'verdant'], 'total'); second.attackers = ['aurora', 'verdant'];
    const third = createWar(state, ['aurora', 'cobalt'], 'total'); third.attackers = ['aurora'];
    expect(warBurden(state, 'aurora')).toMatchObject({ multiplier: 1.6, unity: -3 });
    expect(warBurden(state, 'verdant').offensive).toBe(1);
    settleWar(state, first, false, '测试停战');
    expect(warBurden(state, 'aurora').multiplier).toBe(1.5);
    state.rulesRevision = '4.1';
    expect(warBurden(state, 'aurora').multiplier).toBe(1);
  });
  it('仅舰船电矿维护增加，建筑和粮食不变', () => {
    const state = fixture(); const before = local(state);
    createWar(state, ['aurora', 'umbra'], 'total').attackers = ['aurora'];
    const after = local(state);
    expect(after.upkeep.aurora.energy - before.upkeep.aurora.energy).toBe(units(6 * 0.25 / 10));
    expect(after.upkeep.aurora.minerals - before.upkeep.aurora.minerals).toBe(units(3 * 0.25 / 10));
    expect(after.upkeep.aurora.food).toBe(before.upkeep.aurora.food);
    expect(after.income.aurora).toEqual(before.income.aurora);
  });
  it('航道及紧急撤离舰队同样承担维护', async () => {
    const state = fixture(); createWar(state, ['aurora', 'umbra'], 'total').attackers = ['aurora'];
    const normal = await advanceRound(state, pools[0]);
    const travelling = structuredClone(state);
    travelling.fleets[0].systemId = null;
    travelling.fleets[0].transit = { from: state.systems[0].id, to: state.systems[0].neighbors[0], remainingDays: 1000 };
    const result = await advanceRound(travelling, pools[0]);
    expect(result.factions.aurora.lastIncome).toEqual(normal.factions.aurora.lastIncome);
    travelling.fleets[0].transit = null;
    travelling.fleets[0].withdrawal = { hostId: 'umbra', deadline: 1000, emergencyUntil: 1000, destinationId: state.systems[0].id };
    expect((await advanceRound(travelling, pools[0])).factions.aurora.lastIncome).toEqual(normal.factions.aurora.lastIncome);
  });
  it('720实际控制日、占领暂停、成果延迟；再次易主重置而宣称割让不产生整合', () => {
    const state = fixture(); const system = state.systems[0];
    const war = createWar(state, ['aurora', 'umbra'], 'total');
    cedeSystem(state, system, 'umbra', war.id);
    expect(system.annexation?.controlledDays).toBe(0);
    expect(scoreBreakdown(state, 'umbra').territory).toBe(0);
    const factors = Object.fromEntries(Object.entries(state.factions).map(([id, faction]) => [id, { ...faction }])) as Record<string, FactionFactors>;
    const controllers = () => Object.fromEntries(state.systems.map(system => [system.id, controller(system)]));
    for (let index = 0; index < 71; index++) { state.day += 10; finishBalanceInterval(state, factors, controllers()); }
    system.controllerId = 'aurora'; state.day += 10; finishBalanceInterval(state, factors, controllers());
    expect(system.annexation?.controlledDays).toBe(710);
    delete system.controllerId; state.day += 10; finishBalanceInterval(state, factors, controllers());
    expect(system.annexation?.controlledDays).toBe(720);
    expect(scoreBreakdown(state, 'umbra').territory).toBe(100);
    cedeSystem(state, system, 'aurora', war.id); expect(system.annexation?.controlledDays).toBe(0);
    war.type = 'claim'; cedeSystem(state, system, 'umbra', war.id);
    expect(system.annexation).toBeUndefined(); expect(scoreBreakdown(state, 'umbra').territory).toBe(100);
  });
  it('生产、人口与非固定建设减半；占领不叠加，维护全额，固定工期不变', () => {
    const state = fixture(); const system = state.systems[0]; const planet = system.planets[0];
    const before = local(state);
    system.annexation = { ownerId: 'aurora', warId: 'test', startedDay: 0, controlledDays: 0 };
    const after = local(state);
    expect(after.income.aurora.minerals).toBe(before.income.aurora.minerals / 2);
    expect(after.upkeep.aurora).toEqual(before.upkeep.aurora);
    expect(after.systems[0].planets[0].growthDays).toBe(5);
    expect(cohesionBreakdown(state, 'aurora').buildings).toBe(-2);
    for (const kind of ['building', 'ship', 'survey', 'colonize', 'consecrate'] as const) system.projects.push({ id: kind, kind, ownerId: 'aurora', planetId: planet.id, structureType: 'mine', shipType: 'destroyer', progress: 0, requiredDays: 500, cost: { energy: 0, food: 0, minerals: 0 }, createdDay: 0 });
    const advanced = local(state, 'advance').systems[0].projects;
    for (const project of advanced) expect(project.progress).toBe(units(['building', 'ship'].includes(project.kind) ? 5.5 : 10));
    system.controllerId = 'umbra'; expect(annexationFactor(system)).toBe(1);
    expect(local(state).income.aurora.minerals).toBe(0);
  });
});
describe('4.2 乌托邦、信仰与文明分', () => {
  it('乌托邦三个等级、人口1.25及旧倍率保持', () => {
    const state = fixture(); const faction = state.factions.aurora; faction.policy!.choice = 'utopia';
    for (const [streak, expected] of [[0, 0.85], [2, 0.90], [3, 0.95]]) { faction.beacon!.streak = streak; expect(currentPolicy(state, 'aurora').energy).toBe(expected); }
    expect(cohesionBreakdown(state, 'aurora').policy + cohesionBreakdown(state, 'aurora').beacon).toBe(10);
    expect(local(state).systems[0].planets[0].growthDays).toBe(12.5);
    faction.shortages.food = true; expect(local(state).systems[0].planets[0].growthDays).toBe(0);
    state.rulesRevision = '4.1'; expect(currentPolicy(state, 'aurora').energy).toBe(0.8);
  });
  it('社会协作严格检查危机19/20、祝圣、法理与实际控制', () => {
    const state = fixture(); const religion = faith(state);
    religion.crisis = 19; expect(holyCooperation(state, 'aurora')).toBe(true);
    religion.crisis = 20; expect(holyCooperation(state, 'aurora')).toBe(false);
    religion.crisis = 0; state.systems[0].controllerId = 'umbra'; expect(holyCooperation(state, 'aurora')).toBe(false);
    delete state.systems[0].controllerId; expect(holyCooperation(state, 'aurora')).toBe(true);
    delete religion.sites[0].consecratedDay; expect(holyCooperation(state, 'aurora')).toBe(false);
  });
  it('实际经济得到5%社会协作，建设速度不获得该加成', async () => {
    const state = fixture(); faith(state);
    const planet = state.systems[0].planets[0];
    state.systems[0].projects.push({ id: 'holy-building', kind: 'building', ownerId: 'aurora', planetId: planet.id, structureType: 'mine', shipType: null, progress: 0, requiredDays: 500, cost: { energy: 0, food: 0, minerals: 0 }, createdDay: 0 });
    let firstProduction = 0;
    await advanceRound(state, pools[0], {}, async batch => {
      if (batch.day === 10) firstProduction = (batch.economy as { factionId: string; production: { energy: number } }[]).find(entry => entry.factionId === 'aurora')!.production.energy;
    });
    expect(firstProduction).toBe(units(100 * 1.1 * 1.05 / 10));
    const input = { ...state.factions.aurora, balance: true, faithProduction: 1, holyProduction: 1.05 };
    const result = processLocal({ phase: 'advance', day: 10, seed: state.config.seed, systems: [structuredClone(state.systems[0])], fleets: [], relations: state.relations, factions: { aurora: input } });
    expect(result.systems[0].projects[0].progress).toBe(units(11));
  });
  it('文明授分永久去重、共享1500上限、圣地失守失分及收复不叠加', () => {
    const state = fixture(); faith(state);
    awardCivilization(state, 'aurora', 'utopia', 0, {}); awardCivilization(state, 'aurora', 'utopia', 0, {});
    expect(civilizationScore(state, 'aurora').total).toBe(300);
    state.systems[0].controllerId = 'umbra'; expect(civilizationScore(state, 'aurora')).toMatchObject({ total: 100, unavailableHoly: 200 });
    delete state.systems[0].controllerId; expect(civilizationScore(state, 'aurora').total).toBe(300);
    for (let term = 0; term < 30; term++) awardCivilization(state, 'aurora', 'faith', term, {});
    expect(scoreBreakdown(state, 'aurora').civilization).toBe(1500);
  });
  it('720日任期精确授分且90%门槛；中途立教无完整任期分', () => {
    const state = fixture(); faith(state);
    const previous = Object.fromEntries(Object.entries(state.factions).map(([id, faction]) => [id, { ...faction, stableFaithInterval: id === 'aurora' }])) as Record<string, FactionFactors>;
    for (let day = 10; day <= 720; day += 10) { state.day = day; previous.aurora.stableFaithInterval = day > 70; finishBalanceInterval(state, previous, {}); }
    expect(civilizationScore(state, 'aurora').faith).toBe(100);
    for (let day = 730; day <= 1440; day += 10) { state.day = day; previous.aurora.stableFaithInterval = day > 800; finishBalanceInterval(state, previous, {}); }
    expect(civilizationScore(state, 'aurora').faith).toBe(100);
    const late = fixture(); faith(late).establishedDay = 10;
    for (let day = 10; day <= 720; day += 10) { late.day = day; finishBalanceInterval(late, { ...previous, aurora: { ...previous.aurora, faith: late.factions.aurora.faith } }, {}); }
    expect(civilizationScore(late, 'aurora').faith).toBe(0);
  });
  it('乌托邦合格任期授分和换策保留；迁移不追补且保留旧哈希', () => {
    const original = fixture(); original.rulesRevision = '4.1'; original.day = 700;
    original.factions.aurora.policy!.choice = 'utopia'; original.factions.aurora.beacon!.totalDays = 700; original.factions.aurora.beacon!.suppliedDays = 700;
    const hash = stateHash(original); const migrated = migrateBalance(original);
    for (let day = 710; day <= 1440; day += 10) { migrated.day = day; trackBeacon(migrated, migrated.factions); }
    expect(civilizationScore(migrated, 'aurora').utopia).toBe(100);
    migrated.factions.aurora.policy!.choice = 'balanced'; expect(civilizationScore(migrated, 'aurora').utopia).toBe(100);
    expect(stateHash(original)).toBe(hash); expect(original.systems.every(system => !system.annexation)).toBe(true);
  });
});
describe('4.2 信息、持久化与确定性', () => {
  it('战争和立教资格与命令共用校验；修改隐藏敌军经济不改变对照', () => {
    const state = fixture(); const initialHash = stateHash(state); const before = decisionComparison(state, 'aurora');
    expect(stateHash(state)).toBe(initialHash);
    state.factions.umbra.resources.minerals *= 100; state.factions.umbra.unity = 0; state.fleets.find(fleet => fleet.ownerId === 'umbra')!.ships[0].hull = 999;
    expect(decisionComparison(state, 'aurora')).toEqual(before);
    for (const candidate of before.religion.candidates) expect(new StagingArea(state, 'aurora').execute('establish_religion', { planetId: candidate.planetId, name: '测试', doctrine: '测试', acknowledgePermanent: true }).ok).toBe(candidate.allowed);
    faith(state); state.factions.aurora.stableFaith = { term: 0, totalDays: 300, qualifiedDays: 300, wholeTerm: true };
    const query = new StagingArea(state, 'aurora').execute('get_faith', {});
    expect(JSON.stringify(query)).toContain('qualifiedDays');
    expect(JSON.stringify(query)).toContain('holyCooperation');
    expect(viewpoint(state, 'umbra').factions.aurora.stableFaith).toBeUndefined();
    expect(observation(state, 'umbra').comparison?.religion.candidates).toEqual([]);
  });
  it('0/2/8 workers及中途JSON恢复的混合状态哈希一致', async () => {
    const state = fixture(); faith(state); state.day = 700; state.round = 7;
    createWar(state, ['aurora', 'umbra'], 'total').attackers = ['umbra'];
    state.systems[0].annexation = { ownerId: 'aurora', warId: 'mixed', startedDay: 0, controlledDays: 700 };
    const results = await Promise.all(pools.map(pool => advanceRound(structuredClone(state), pool)));
    expect(new Set(results.map(stateHash)).size).toBe(1);
    const continuous = await advanceRound(results[0], pools[0]);
    const restored = await advanceRound(JSON.parse(JSON.stringify(results[1])), pools[1]);
    expect(stateHash(restored)).toBe(stateHash(continuous));
  });
  it('静态比较与真实固定设施十日经济相符，凝聚力封顶显示有效变化', () => {
    const state = fixture(); state.factions.aurora.unity = 10000;
    for (const option of policyComparison(state, 'aurora')) {
      state.factions.aurora.policy!.choice = option.choice;
      const actual = local(state);
      expect(actual.income.aurora.energy / 100).toBeCloseTo(option.production.energy, 2);
      expect(option.effectiveUnityChange).toBeLessThanOrEqual(0);
    }
  });
});
