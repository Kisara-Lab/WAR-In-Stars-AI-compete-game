import {describe,it,expect,vi} from 'vitest';
import {DEFAULT_CONFIG,units,STRUCTURES} from '../src/shared/rules.js';
import {createGame} from '../src/sim/world.js';
import {scriptKnowledge} from '../src/sim/adaptive-knowledge.js';
import {candidateFacts} from '../src/sim/adaptive-candidates.js';
import {functionalValue,routeComparison} from '../src/sim/adaptive-v2-values.js';
import {adaptiveV2Decision} from '../src/sim/adaptive-v2.js';
import {PlanningPool,planningConfig} from '../src/sim/planning-pool.js';
import {decisionComparison} from '../src/sim/options.js';
import {stateHash} from '../src/sim/math.js';
import {advanceRound} from '../src/sim/engine.js';
import {SimulationPool} from '../src/sim/pool.js';
import {commitScriptMemory} from '../src/sim/adaptive-adapter.js';
import {StagingArea} from '../src/sim/actions.js';
import {failureConditions} from '../src/sim/adaptive-v2-failures.js';

const game=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v2'},'v2-fixture');
vi.mock('node:os',async importOriginal=>({...await importOriginal<typeof import('node:os')>(),availableParallelism:()=>32}));
const rich=()=>{const state=game();state.factions.aurora.resources={energy:units(20000),food:units(20000),minerals:units(20000),alloys:units(2000)};return state;};

describe('adaptive-v2 运营与战略',()=>{
  it('施工失败不会被库存或军事情报刷新解锁，殖民情报变化才重试',()=>{
    const state=rich(),home=state.systems.find(system=>system.ownerId==='aurora')!,planet=home.planets[0];
    const actions=[{type:'build_structure',args:{planetId:planet.id,structureType:'lrs'}}];
    const before=failureConditions(state,'aurora',actions);
    state.factions.aurora.resources.minerals+=units(100);
    state.factions.aurora.militaryIntel![home.id]={day:100,source:'lrs',ownerId:'aurora',controllerId:'aurora',base:home.base,fleets:[]};
    expect(failureConditions(state,'aurora',actions)).toBe(before);
    state.factions.aurora.intel[home.id].day++;
    expect(failureConditions(state,'aurora',actions)).not.toBe(before);
  });
  it('终局前无法完成的扩槽不下单',async()=>{
    const state=rich(),planet=state.systems.find(system=>system.ownerId==='aurora')!.planets[0];
    state.round=111;state.day=11100;state.factions.aurora.unity=0;state.factions.aurora.shortages={energy:true,food:true,minerals:true};
    planet.population=24;delete planet.operation;
    planet.structures=Array.from({length:8},(_,index)=>({id:'idle-'+index,type:'mine' as const,sealed:true}));
    const world=scriptKnowledge(state,'aurora');
    expect(candidateFacts(world,'aurora',true).candidates.some(candidate=>candidate.kind==='expand')).toBe(true);
    const decision=await adaptiveV2Decision(world,'aurora',undefined);
    expect(decision.actions.some(action=>action.type==='expand_slots')).toBe(false);
    expect(decision.scriptReport!.alternatives.some(option=>option.reason.includes('终局'))).toBe(true);
  },30000);
  it('建筑归类、预留和真实队列使用同一地表轨道规则',()=>{
    const state=rich(),home=state.systems.find(system=>system.ownerId==='aurora')!,planet=home.planets[0];planet.population=16;
    expect(STRUCTURES.lrs.slot).toBe('orbital');expect(STRUCTURES.foundry.slot).toBe('ground');
    const stage=new StagingArea(state,'aurora');
    expect(stage.execute('build_structure',{planetId:planet.id,structureType:'lrs'}).ok).toBe(true);
    expect(stage.draft.systems.find(system=>system.id===home.id)!.projects.some(project=>project.planetId===planet.id&&project.structureType==='lrs')).toBe(true);
    expect(home.projects).toHaveLength(0);
  });
  it('LRS覆盖有价值，封存失去覆盖，重复传感不重复加分',()=>{
    const state=rich(),home=state.systems.find(system=>system.ownerId==='aurora')!,planet=home.planets[0];planet.population=24;delete planet.operation;
    planet.structures.push({id:'sensor',type:'lrs'});planet.priorities={lrs:5};
    const active=functionalValue(state,'aurora');expect(active.sensors.find(sensor=>sensor.planetId===planet.id)?.active).toBe(true);
    planet.structures.push({id:'duplicate',type:'lrs'});expect(functionalValue(state,'aurora').value).toBe(active.value);
    planet.structures.filter(building=>building.type==='lrs').forEach(building=>building.sealed=true);
    expect(functionalValue(state,'aurora').value).toBeLessThan(active.value);
    const facts=candidateFacts(scriptKnowledge(state,'aurora'),'aurora',true);
    expect(facts.candidates.some(candidate=>candidate.actions.some(action=>action.type==='set_jobs'&&action.args.structureType==='lrs')&&candidate.actions.some(action=>action.type==='set_structure_status'&&action.args.sealed===false))).toBe(true);
  });
  it('征服准备不要求当下军力或200日新鲜军情',()=>{
    const state=rich(),home=state.systems.find(system=>system.ownerId==='aurora')!,target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    state.day=1000;state.round=10;target.ownerId='umbra';target.base={hull:40};target.planets[0].ownerId='umbra';target.planets[0].population=2;
    const relation=Object.values(state.relations).find(relation=>relation.factions.includes('aurora')&&relation.factions.includes('umbra'))!;relation.status='peace';relation.confirmed=['aurora','umbra'];
    state.factions.aurora.surveyed.push(target.id);state.factions.aurora.intel[target.id]={day:100,system:structuredClone(target),fleets:[]};
    const world=scriptKnowledge(state,'aurora');const facts=candidateFacts(world,'aurora',true);
    expect(facts.candidates.some(candidate=>candidate.actions.some(action=>action.type==='prepare_conquest'))).toBe(true);
    expect(facts.candidates.some(candidate=>candidate.actions.some(action=>action.type==='declare_war'))).toBe(false);
    const routes=routeComparison(world,'aurora',decisionComparison(world,'aurora',false));expect(routes.map(row=>row.choice)).toEqual(['secular','utopia','militarist','theocracy']);
  });
  it('降低福利的节省不能成为军国承诺收益；未接触时保留世俗',()=>{
    const state=rich();state.factions.aurora.welfare!.choice='utopian';
    const world=scriptKnowledge(state,'aurora'),routes=routeComparison(world,'aurora',decisionComparison(world,'aurora',false));
    const military=routes.find(option=>option.choice==='militarist')!;
    expect(military.value).toBeLessThan(0);expect(military.economy).toBeLessThanOrEqual(0);
  });
  it('缺员建筑不当作新产能；暂时船厂停工不触发循环退款',async()=>{
    const state=rich(),planet=state.systems.find(system=>system.ownerId==='aurora')!.planets[0];planet.population=2;
    const stage=new StagingArea(state,'aurora');stage.execute('queue_ships',{planetId:planet.id,shipType:'destroyer',count:2});
    const facts=candidateFacts(scriptKnowledge(stage.draft,'aurora'),'aurora',true);
    expect(facts.candidates.filter(candidate=>candidate.kind==='cancel')).toHaveLength(0);
    const decision=await adaptiveV2Decision(scriptKnowledge(state,'aurora'),'aurora',undefined);
    expect(decision.actions.some(action=>action.type==='build_structure'&&['mine','foundry'].includes(action.args.structureType as string))).toBe(false);
    expect(decision.actions.length).toBeLessThanOrEqual(48);expect(decision.scriptReport!.forecasts).toBeLessThanOrEqual(24);
  },30000);
  it('隐藏外国资产不影响动作或解释，查询不修改原世界',async()=>{
    const state=game(),changed=structuredClone(state),hash=stateHash(state);
    changed.factions.umbra.resources.energy=0;changed.factions.umbra.unity=0;
    changed.systems.find(system=>system.ownerId==='umbra')!.planets[0].population=24;
    const first=await adaptiveV2Decision(scriptKnowledge(state,'aurora'),'aurora',undefined);
    const second=await adaptiveV2Decision(scriptKnowledge(changed,'aurora'),'aurora',undefined);
    expect(second.actions).toEqual(first.actions);expect(second.summary).toBe(first.summary);expect(second.scriptMemory).toEqual(first.scriptMemory);
    expect(second.scriptReport!.comparisons).toEqual(first.scriptReport!.comparisons);expect(stateHash(state)).toBe(hash);
  },30000);
});

describe('adaptive-v2 并行与原子边界',()=>{
  it('串行和2/8预测worker结果、恢复及世界哈希一致',async()=>{
    const hashes:string[]=[];let reference:unknown;
    for(const count of [0,2,8]) {
      const pool=new PlanningPool(4,{planningWorkers:count?2:0,forecastWorkers:count}),simulation=new SimulationPool(count);
      try {
        const state=JSON.parse(JSON.stringify(game()));const decisions=await pool.decide(state);
        const comparable=Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,{actions:decision.actions,memory:decision.scriptMemory,summary:decision.summary}]));
        if(reference)expect(comparable).toEqual(reference);else reference=comparable;
        const next=await advanceRound(state,simulation,Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,decision.actions])));commitScriptMemory(next,decisions);hashes.push(stateHash(next));
        expect(Object.values(decisions).every(decision=>decision.metrics.requests===0&&decision.metrics.totalTokens===0)).toBe(true);
      } finally {await pool.close();await simulation.close();}
    }
    expect(new Set(hashes).size).toBe(1);
  },120000);
  it('暂停和任一worker错误不产生部分决策；线程配置不进入世界',async()=>{
    const state=game(),hash=stateHash(state),pool=new PlanningPool(4,{planningWorkers:2,forecastWorkers:2});
    try {const abort=new AbortController(),pending=pool.decide(state,abort.signal);abort.abort();await expect(pending).rejects.toThrow();expect(stateHash(state)).toBe(hash);}finally{await pool.close();}
    const broken=new PlanningPool(4,{planningWorkers:2,forecastWorkers:2});
    try {state.rulesRevision='5.3';await expect(broken.decide(state)).rejects.toThrow('5.4');expect(state.factions.aurora.scriptMemory).toBeUndefined();}finally{await broken.close();}
    expect(planningConfig(4,{planningWorkers:0,forecastWorkers:0})).toEqual({planningWorkers:0,forecastWorkers:0});
  },30000);
});
