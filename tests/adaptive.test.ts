import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ADAPTIVE} from '../src/shared/adaptive.js';
import {DEFAULT_CONFIG,units} from '../src/shared/rules.js';
import {viewpoint} from '../src/shared/viewpoint.js';
import {createGame} from '../src/sim/world.js';
import {adaptiveContext,adaptiveDecision,commitScriptMemory,validateScriptPlan} from '../src/sim/adaptive-adapter.js';
import {scriptKnowledge} from '../src/sim/adaptive-knowledge.js';
import {adaptiveResourceWeights} from '../src/sim/adaptive-economics.js';
import {planAdaptive} from '../src/sim/adaptive-planner.js';
import {scriptedDecision} from '../src/sim/bot.js';
import {decisionComparison} from '../src/sim/options.js';
import {stateHash} from '../src/sim/math.js';
import {advanceRound} from '../src/sim/engine.js';
import {SimulationPool} from '../src/sim/pool.js';
import {StagingArea} from '../src/sim/actions.js';
import {createWar} from '../src/sim/wars.js';
import {MatchRunner} from '../src/server/runner.js';
import {MatchStore} from '../src/server/storage.js';
import type {Action,Decision,GameState} from '../src/shared/types.js';
import type {ScriptCandidate,ScriptObservation} from '../src/sim/adaptive-types.js';

const game=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v1'},'adaptive-test');
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const rich=(state=game())=>{state.factions.aurora.resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:units(10000)};return state;};
const fixture=async(state=game(),script?:ConstructorParameters<typeof MatchRunner>[4])=>{
  const folder=await mkdtemp(join(tmpdir(),'adaptive-test-'));cleanup.push(()=>rm(folder,{force:true,recursive:true}));
  const runner=new MatchRunner(state,new SimulationPool(0),new MatchStore(join(folder,'matches'),join(folder,'session.json')),async()=>{throw new Error('禁止模型请求');},script,false);
  cleanup.push(()=>runner.close());await runner.initialize();return runner;
};
function contact(state:GameState,target:string) {const relation=Object.values(state.relations).find(relation=>relation.factions.includes('aurora')&&relation.factions.includes(target))!;relation.status='peace';relation.confirmed=['aurora',target];return relation;}

describe('adaptive-v1 信息与确定性',()=>{
  it('历史中文触发原因沿用英文环境的规范排序，不随本机语言改变哈希',()=>{
    const state=game();state.events=[{id:'test',day:0,round:0,type:'game',text:'fixture',audience:['aurora'],systemId:null,details:{'主圣地失守':1,'持续信仰危机':2,'外国教派思想争端':3}}];
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,value])=>value!==undefined).sort(([first],[second])=>first.localeCompare(second,'en')).map(([key,value])=>[key,canonical(value)])):value;
    expect(stateHash(state)).toBe(createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex'));
  });
  it('隐藏外国库存、人口、危机、队列与舰队变化不改变输入、动作或解释',async()=>{
    const original=game(),hidden=structuredClone(original),home=hidden.systems.find(system=>system.ownerId==='umbra')!;
    hidden.factions.umbra.resources={energy:1,food:2,minerals:3,alloys:4};hidden.factions.umbra.unity=0;
    home.planets[0].population=24;home.planets[0].structures=[];
    hidden.fleets.find(fleet=>fleet.ownerId==='umbra')!.ships.push({id:'secret',type:'dreadnought',hull:200});
    const hash=stateHash(original),first=adaptiveContext(original,'aurora'),second=adaptiveContext(hidden,'aurora');
    expect(second.input).toEqual(first.input);expect(Object.isFrozen(first.input.candidates)).toBe(true);
    const left=await adaptiveDecision(original,'aurora'),right=await adaptiveDecision(hidden,'aurora');
    expect(right.actions).toEqual(left.actions);expect(right.summary).toBe(left.summary);expect(right.scriptReport).toEqual(left.scriptReport);expect(right.scriptMemory).toEqual(left.scriptMemory);
    expect(stateHash(original)).toBe(hash);expect(left.metrics.requests).toBe(0);expect(left.metrics.totalTokens).toBe(0);
  },30000);
  it('新军事扫描不能更新殖民日期，闭境通行和拓扑可达分别展示',()=>{
    const state=game(),target=state.systems.find(system=>system.ownerId==='umbra')!;
    state.day=500;contact(state,'umbra');state.factions.aurora.intel[target.id]={day:10,system:structuredClone(target),fleets:[]};
    state.factions.aurora.militaryIntel![target.id]={day:490,source:'lrs',ownerId:'umbra',base:target.base,fleets:[]};
    const world=scriptKnowledge(state,'aurora'),comparison=decisionComparison(world,'aurora',false).wars.find(war=>war.target==='umbra')!;
    const intel=comparison.targetIntel!.find(intel=>intel.systemId===target.id)!;
    expect(intel.colonyIntelDay).toBe(10);expect(intel.militaryIntelDay).toBe(490);
    expect(intel.travel[0]).toMatchObject({topologicallyReachable:true,legalTransit:false,knownLegalPath:null});
  });
  it('已有宣称成熟与新建宣称日期分开',()=>{
    const state=game(),home=state.systems[0],target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    target.ownerId='umbra';state.factions.aurora.intel[target.id]={day:0,system:structuredClone(target),fleets:[]};contact(state,'umbra');state.round=5;
    state.claims=[{factionId:'aurora',targetId:'umbra',systemId:target.id,createdRound:1,expiresDay:1800}];
    const claim=decisionComparison(scriptKnowledge(state,'aurora'),'aurora',false).wars.find(war=>war.target==='umbra')!.claims[0];
    expect(claim.existingClaim).toMatchObject({matureRound:2,mature:true});expect(claim.newClaimEarliestWarRound).toBe(6);
  });
  it('0/2/8 workers及JSON恢复的世界与记忆哈希一致',async()=>{
    const hashes:string[]=[];
    for(const workers of [0,2,8]) {
      const pool=new SimulationPool(workers);cleanup.push(()=>pool.close());let state=game();
      for(let round=0;round<3;round++) {
        const decisions:Record<string,Decision>={};for(const actor of state.config.factionIds)decisions[actor]=await adaptiveDecision(state,actor);
        state=await advanceRound(state,pool,Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,decision.actions])));commitScriptMemory(state,decisions);
        if(workers===2)state=JSON.parse(JSON.stringify(state));
      }
      hashes.push(stateHash(state));expect(state.factions.aurora.scriptMemory?.version).toBe('adaptive-v1');
    }
    expect(new Set(hashes).size).toBe(1);
  },120000);
  it('外方策略记忆在受限视角隐藏；缺省策略保持旧行为',()=>{
    const state=game();state.factions.umbra.scriptMemory={version:'adaptive-v1',goal:null,tasks:[],failures:[{key:'secret',fingerprint:'secret',round:0,reason:'secret'}]};
    expect(viewpoint(state,'aurora').factions.umbra.scriptMemory).toBeUndefined();delete state.config.scriptStrategy;
    const old=scriptedDecision(state,'aurora');state.config.scriptStrategy='legacy';expect(scriptedDecision(state,'aurora').actions).toEqual(old.actions);
  });
});

describe('adaptive-v1 安全与规划场景',()=>{
  it('低人口设施不被当成完整产能，在建冶炼计入比较',async()=>{
    const state=rich(),planet=state.systems[0].planets[0];planet.population=2;
    for(let index=0;index<3;index++)planet.structures.push({id:'extra-'+index,type:'mine'});
    const decision=await adaptiveDecision(state,'aurora');
    expect(decision.actions.filter(action=>action.type==='build_structure'&&action.args.planetId===planet.id&&['mine','foundry'].includes(action.args.structureType as string))).toHaveLength(0);
    const queued=rich(),stage=new StagingArea(queued,'aurora');stage.execute('build_structure',{planetId:planet.id,structureType:'foundry'});
    const context=adaptiveContext(stage.draft,'aurora');
    expect((await adaptiveDecision(stage.draft,'aurora')).actions.some(action=>action.type==='build_structure'&&action.args.planetId===planet.id&&action.args.structureType==='foundry')).toBe(false);
    expect(context.input.candidates.find(candidate=>candidate.actions[0].args.structureType==='foundry'&&candidate.kind==='build')?.reason??'').not.toContain('prepaidIncluded":false');
  },30000);
  it('在途舰队不被改令、未建船厂不下单、终局前无法完成的订单被拒绝',async()=>{
    const state=rich(),fleet=state.fleets[0];fleet.transit={from:'s0',to:state.systems[0].neighbors[0],remainingDays:20};fleet.systemId=null;
    state.round=119;const decision=await adaptiveDecision(state,'aurora');
    expect(decision.actions.some(action=>action.type==='move_fleet'&&action.args.fleetId===fleet.id)).toBe(false);
    expect(decision.actions.some(action=>action.type==='queue_ships'&&action.args.shipType==='dreadnought')).toBe(false);
    state.systems[0].planets[0].structures=state.systems[0].planets[0].structures.filter(building=>building.type!=='shipyard');
    expect(adaptiveContext(state,'aurora').input.candidates.some(candidate=>candidate.kind==='ships')).toBe(false);
  });
  it('最高待遇不自动立国；完整资格通过实际工具复核',async()=>{
    const state=rich();state.factions.aurora.welfare!.choice='utopian';state.factions.aurora.welfare!.highestSince=0;
    const decision=await adaptiveDecision(state,'aurora');expect(decision.actions.some(action=>action.type==='establish_civilization'&&action.args.civilization==='utopia')).toBe(false);
  });
  it('封顶矿物与合金瓶颈使用同一估值；调岗能恢复闲置加工',async()=>{
    const state=rich(),planet=state.systems[0].planets[0];state.factions.aurora.resources.alloys=0;planet.population=10;
    planet.priorities={mine:5,foundry:0};planet.structures.push({id:'mine-extra',type:'mine'});
    const weights=adaptiveResourceWeights(scriptKnowledge(state,'aurora'),'aurora');expect(weights.minerals).toBe(ADAPTIVE.surplusWeight);expect(weights.alloys).toBeGreaterThan(weights.minerals);
    const decision=await adaptiveDecision(state,'aurora');expect(decision.actions.some(action=>action.type==='set_jobs'&&action.args.structureType==='foundry'&&action.args.priority===5)).toBe(true);
  },30000);
  it('普通侦察不闯已知敌方基地；已占目标200日之前保留守军',()=>{
    const state=rich(),home=state.systems[0],target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    target.ownerId='umbra';target.base={hull:40};state.factions.aurora.militaryIntel![target.id]={day:0,source:'lrs',ownerId:'umbra',base:target.base,fleets:[]};contact(state,'umbra').status='war';
    const first=adaptiveContext(state,'aurora');expect(first.input.candidates.some(candidate=>candidate.kind==='scout'&&candidate.target===target.id)).toBe(false);
    target.controllerId='aurora';state.fleets[0].systemId=target.id;
    const war=createWar(state,['aurora','umbra'],'limited');war.goals.aurora=[{systemId:target.id,type:'limited',heldDays:100}];target.occupationWarId=war.id;
    const second=adaptiveContext(state,'aurora');expect(second.input.candidates.some(candidate=>candidate.kind==='hold'&&candidate.tasks.some(task=>task.fleetId===state.fleets[0].id))).toBe(true);
    expect(second.input.candidates.some(candidate=>candidate.kind==='scout'&&candidate.actions.some(action=>action.args.fleetId===state.fleets[0].id))).toBe(false);
  });
  it('乌托邦具备军情、优势及成熟宣称时仍可合法进攻',async()=>{
    const state=rich(),home=state.systems[0],target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    state.round=5;state.day=500;state.factions.aurora.civilization={choice:'utopia',establishedDay:0};state.factions.aurora.welfare!.choice='utopian';
    contact(state,'umbra');target.ownerId='umbra';target.base={hull:40};target.planets[0].ownerId='umbra';target.planets[0].population=2;
    state.factions.aurora.surveyed.push(target.id);state.factions.aurora.intel[target.id]={day:500,system:structuredClone(target),fleets:[]};state.factions.aurora.militaryIntel![target.id]={day:500,source:'lrs',ownerId:'umbra',base:target.base,fleets:[]};
    state.claims=[{factionId:'aurora',targetId:'umbra',systemId:target.id,createdRound:1,expiresDay:1800}];state.fleets[0].ships=[{id:'strong',type:'dreadnought',hull:200}];
    const decision=await adaptiveDecision(state,'aurora');expect(decision.actions.some(action=>action.type==='declare_war'&&action.args.warType==='claim')).toBe(true);expect(decision.actions.some(action=>action.type==='prepare_conquest')).toBe(false);
  },30000);
  it('占领已达标优先兑现，不把无条件停战当保留占领',async()=>{
    const state=rich(),home=state.systems[0],target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    contact(state,'umbra').status='war';target.ownerId='umbra';target.controllerId='aurora';target.base={hull:40};target.planets[0].ownerId='umbra';target.planets[0].population=2;
    const war=createWar(state,['aurora','umbra'],'limited');war.goals.aurora=[{systemId:target.id,type:'limited',heldDays:200}];target.occupationWarId=war.id;
    const context=adaptiveContext(state,'aurora');expect(context.input.candidates.some(candidate=>candidate.actions[0].type==='enforce_peace')).toBe(true);
    const decision=await adaptiveDecision(state,'aurora');expect(decision.actions.some(action=>action.type==='enforce_peace')).toBe(true);expect(decision.actions.some(action=>action.type==='accept_peace')).toBe(false);
  },30000);
  it('相同失败指纹被阻止，条件变化后才能重试',async()=>{
    const candidate:ScriptCandidate={id:'scout',label:'侦察',kind:'scout',target:'s1',actions:[{type:'move_fleet',args:{fleetId:'f1'}}],priority:1,value:10,risk:0,reason:'known',evidenceDays:[10],progress:'unchanged',deadline:1000,economic:false,exclusive:[],fingerprint:'v1',tasks:[]};
    const input:ScriptObservation={actor:'aurora',day:100,round:1,remainingDays:1000,actionLimit:48,facts:{},candidates:[candidate],generated:1,truncated:false};
    const memory={version:'adaptive-v1' as const,goal:null,tasks:[],failures:[{key:'scout',fingerprint:'v1',round:0,reason:'闭境'}]};
    const api={yield:async()=>{},preview:()=>({ok:true,reason:'',value:10,risk:0,actionCount:1})};
    expect((await planAdaptive(input,memory,api)).actions).toHaveLength(0);candidate.fingerprint='v2';expect((await planAdaptive(input,memory,api)).actions).toHaveLength(1);
  });
});

describe('adaptive-v1 原子边界',()=>{
  it('48/49及批量失败都不改变原边界',()=>{
    const state=game(),hash=stateHash(state),planetId=state.systems[0].planets[0].id;
    const orders:Action[]=Array.from({length:48},(_,index)=>({type:'set_jobs',args:{planetId,structureType:'mine',priority:index%6}}));
    expect(validateScriptPlan(state,'aurora',orders).ok).toBe(true);expect(validateScriptPlan(state,'aurora',[...orders,orders[0]]).ok).toBe(false);
    expect(validateScriptPlan(state,'aurora',[{type:'queue_ships_many',args:{orders:[{planetId,shipType:'destroyer',count:1},{planetId:'invalid',shipType:'destroyer',count:1}]}}]).ok).toBe(false);
    expect(stateHash(state)).toBe(hash);
  });
  it('三次校验失败抛错，失败规划不推进记忆',async()=>{
    const state=rich(),hash=stateHash(state);let calls=0;
    await expect(adaptiveDecision(state,'aurora',undefined,{validate:(world,actor,actions)=>{calls++;return {ok:false,index:actions.length-1,reason:'测试故障',stage:new StagingArea(world,actor)};}})).rejects.toThrow('三次');
    expect(calls).toBe(ADAPTIVE.attempts);expect(stateHash(state)).toBe(hash);expect(state.factions.aurora.scriptMemory).toBeUndefined();
  });
  it('任一控制器失败不提交其他方；暂停不推进世界或记忆',async()=>{
    const state=game(),runner=await fixture(state,async(world,actor)=>{if(actor==='umbra')throw new Error('故障');return adaptiveDecision(world,actor);}),hash=stateHash(state);
    runner.start(true);await runner.waitIdle();expect(runner.status.phase).toBe('error');expect(stateHash(runner.state)).toBe(hash);expect(runner.lastDecisions).toBeNull();
    const paused=await fixture();const before=stateHash(paused.state);paused.start();paused.pause();await paused.waitIdle();expect(paused.status.busy).toBe(false);expect(paused.status.phase).toBe('paused');expect(stateHash(paused.state)).toBe(before);
  },30000);
  it('原子存档恢复包含策略记忆且不调用模型',async()=>{
    const runner=await fixture();runner.start(true);await runner.waitIdle();expect(runner.status.error).toBeNull();
    const checkpoint=await runner.store.load(runner.state.id);expect(stateHash(checkpoint.state)).toBe(stateHash(runner.state));expect(checkpoint.state.factions.aurora.scriptMemory?.version).toBe('adaptive-v1');expect(runner.status.metrics.aurora.requests).toBe(0);
  },30000);
});
