import { describe,it,expect } from 'vitest';
import { DEFAULT_CONFIG,units } from '../src/shared/rules.js';
import { ADAPTIVE_V3 } from '../src/shared/adaptive.js';
import { createGame } from '../src/sim/world.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { adaptiveV3Decision,v3FailureDependency } from '../src/sim/adaptive-v3.js';
import { economicForecast } from '../src/sim/forecast.js';
import { PlanningCache } from '../src/sim/planning-cache.js';
import { computeConfig,PlanningPool } from '../src/sim/planning-pool.js';
import { stateHash } from '../src/sim/math.js';
import { StagingArea } from '../src/sim/actions.js';
import { availableParallelism } from 'node:os';
import { advanceRound } from '../src/sim/engine.js';
import { SimulationPool } from '../src/sim/pool.js';
import { commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { stateChanges,applyStateChanges } from '../src/sim/planning-delta.js';
import { campaignCandidates, defenseOutlook, defenseCandidates } from '../src/sim/adaptive-v3-campaign.js';
import type { ScriptMemory } from '../src/shared/adaptive.js';
import type { ScriptCandidate } from '../src/sim/adaptive-types.js';
import { candidateFacts } from '../src/sim/adaptive-candidates.js';
import { newResponsibility } from '../src/shared/responsibility.js';
import { forecastResponsibility } from '../src/sim/forecast-v3.js';
import { v3Coverage, v3PositionValue } from '../src/sim/adaptive-v3-values.js';
import { relationKey } from '../src/shared/diplomacy.js';

const game=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v3',scriptSearchProfile:'standard'},'v3-fixture');

describe('adaptive-v3 fixed work and isolation',()=>{
  it('continues useful independent actions after combination forecasts and rejects action 49',async()=>{
    const state=game();state.config.maxRounds=2;
    const own=state.factions.aurora,home=state.systems.find(system=>system.ownerId==='aurora')!,source=state.fleets.find(fleet=>fleet.ownerId==='aurora')!;
    own.resources={energy:units(100000),food:units(100000),minerals:units(100000),alloys:units(100000)};
    state.fleets=Array.from({length:49},(_,index)=>({...structuredClone(source),id:'command-'+index,systemId:home.id,order:null,transit:null}));
    const world=scriptKnowledge(state,'aurora'),generated=candidateFacts(world,'aurora',true);
    const candidates:ScriptCandidate[]=world.fleets.map(fleet=>({id:fleet.id,label:fleet.id,kind:'scout',target:home.id,actions:[{type:'move_fleet',args:{fleetId:fleet.id,systemId:home.id,x:700,y:700,targetFleetId:null}}],priority:0,value:10,risk:0,reason:'independent useful fixture mission',evidenceDays:[0],progress:'',deadline:200,economic:false,exclusive:['fleet:'+fleet.id],fingerprint:'',tasks:[]}));
    const decision=await adaptiveV3Decision(world,'aurora',undefined,{candidates:async()=>({...generated,candidates})});
    expect(decision.actions).toHaveLength(48);
    expect(decision.scriptReport!.turn!.stages.residual.actions).toBeGreaterThan(0);
    expect(decision.scriptReport!.turn!.stages.combination.forecasts).toBeLessThanOrEqual(24);
    expect(decision.scriptReport!.forecasts).toBeLessThanOrEqual(48);
    const stage=new StagingArea(world,'aurora');
    for(const candidate of candidates.slice(0,48))expect(stage.execute(candidate.actions[0].type,candidate.actions[0].args).ok).toBe(true);
    const hash=stateHash(stage.draft);expect(stage.execute(candidates[48].actions[0].type,candidates[48].actions[0].args).ok).toBe(false);
    expect(stage.actions).toHaveLength(48);expect(stateHash(stage.draft)).toBe(hash);
  },30000);
  it('rejects high welfare that exhausts supplies beyond the first 300 days',async()=>{
    const state=game(),own=state.factions.aurora;
    const planet=state.systems.find(system=>system.ownerId==='aurora')!.planets[0];
    planet.population=20;delete planet.operation;planet.structures=[{id:'farm1',type:'farm'},{id:'farm2',type:'farm'},{id:'solar',type:'solar'},{id:'mine',type:'mine'}];
    own.resources={energy:units(900),food:units(300),minerals:units(900),alloys:0};
    const world=scriptKnowledge(state,'aurora'),generated=candidateFacts(world,'aurora',true);
    const choices=generated.candidates.filter(candidate=>candidate.kind==='welfare'&&candidate.actions[0].args.welfare==='utopian');
    expect(choices).toHaveLength(1);
    const upgraded=structuredClone(world);upgraded.factions.aurora.welfare!.choice='utopian';
    const normal=economicForecast(world,'aurora',[300,720,1440],{actionable:false});
    const expensive=economicForecast(upgraded,'aurora',[300,720,1440],{actionable:false});
    expect(expensive.horizons.at(-1)!.unpaidDays).toBeGreaterThan(normal.horizons.at(-1)!.unpaidDays);
    const decision=await adaptiveV3Decision(world,'aurora',undefined,{candidates:async()=>({...generated,candidates:choices})});
    expect(decision.actions.some(action=>action.type==='set_welfare'&&action.args.welfare==='utopian')).toBe(false);
  },30000);
  it('detects approaching border fleets and values paid defenders before arrival',()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!,border=state.systems.find(system=>home.neighbors.includes(system.id))!;
    const enemy=structuredClone(state.fleets.find(fleet=>fleet.ownerId==='umbra')!);enemy.systemId=border.id;enemy.order=null;enemy.ships=Array.from({length:10},(_,index)=>({id:'enemy-'+index,type:'destroyer',hull:60}));
    state.relations[relationKey('aurora','umbra')].status='war';
    state.factions.aurora.militaryIntel![border.id]={day:0,source:'lrs',ownerId:enemy.ownerId,base:null,fleets:[enemy]};
    const before=defenseOutlook(state,'aurora').find(threat=>threat.systemId===home.id)!;
    expect(before.arrival).toBeGreaterThan(0);expect(before.deficit).toBeGreaterThan(0);
    const planet=home.planets[0],stage=new StagingArea(state,'aurora');state.factions.aurora.resources.alloys=units(10000);
    stage.draft.factions.aurora.resources.alloys=units(10000);
    expect(stage.execute('queue_ships',{planetId:planet.id,shipType:'destroyer',count:1}).ok).toBe(true);
    home.projects=stage.draft.systems.find(system=>system.id===home.id)!.projects;home.projects[0].progress=home.projects[0].requiredDays*1000-1;
    const after=defenseOutlook(state,'aurora').find(threat=>threat.systemId===home.id)!;
    expect(after.paidPower).toBeGreaterThan(0);expect(after.deficit).toBeLessThan(before.deficit);
    expect(defenseCandidates(state,'aurora').every(candidate=>candidate.kind==='defend')).toBe(true);
  });
  it('uses the same facility values for static and detailed assessments without mutating knowledge',()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!,planet=home.planets[0];
    planet.population=30;planet.structures.push({id:'sensor',type:'lrs'},{id:'dock',type:'drydock'});delete planet.operation;
    const coverage=v3Coverage(state,'aurora'),hash=stateHash(state),value=v3PositionValue(state,'aurora',12000,coverage);
    expect(value.functional).toBeGreaterThan(0);
    const projection=economicForecast(state,'aurora',[10],{actionable:false,coverage,endDay:12000});
    expect(projection.horizons[0].governance!.value!.functional).toBeGreaterThan(0);
    planet.structures.find(structure=>structure.id==='sensor')!.sealed=true;
    expect(v3PositionValue(state,'aurora',12000,coverage).functional).toBeLessThan(value.functional);
    planet.structures.find(structure=>structure.id==='sensor')!.sealed=false;
    delete planet.structures.find(structure=>structure.id==='sensor')!.sealed;
    expect(stateHash(state)).toBe(hash);
  });
  it('deducts prepaid arriving ships from campaign reserves and retains alternative opponents',()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!,target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    target.ownerId='umbra';target.base={hull:500};state.factions.aurora.resources.alloys=units(10000);
    state.factions.aurora.militaryIntel![target.id]={day:0,source:'lrs',ownerId:'umbra',base:target.base,fleets:[]};
    const candidate:ScriptCandidate={id:'conquest',label:'conquest',kind:'prepare',target:target.id,actions:[{type:'prepare_conquest',args:{factionId:'umbra'}}],priority:0,value:100,risk:0,reason:'fixture',evidenceDays:[0],progress:'',deadline:12000,economic:true,exclusive:['conquest'],fingerprint:'',tasks:[]};
    const alternative={...candidate,id:'alternative',target:'cobalt',actions:[{type:'prepare_conquest',args:{factionId:'cobalt'}}]};
    const memory:ScriptMemory={version:'adaptive-v3',goal:null,tasks:[],failures:[]};
    expect(campaignCandidates(state,'aurora',memory,[candidate,alternative]).some(item=>item.id==='alternative')).toBe(true);
    const before=memory.campaign!.reserve.minerals;
    const stage=new StagingArea(state,'aurora');expect(stage.execute('queue_ships',{planetId:home.planets[0].id,shipType:'destroyer',count:1}).ok).toBe(true);
    const queued=stage.draft.systems.find(system=>system.id===home.id)!;queued.projects[0].progress=queued.projects[0].requiredDays*1000-1;
    campaignCandidates(stage.draft,'aurora',memory,[candidate,alternative]);
    expect(memory.campaign!.paidPower).toBeGreaterThan(0);expect(memory.campaign!.reserve.minerals).toBeLessThan(before);
  });
  it('evaluates restart plus staffing even when neither repairs supply alone',async()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!,planet=home.planets[0];
    planet.population=6;delete planet.operation;
    planet.structures=[{id:'food',type:'farm'},...Array.from({length:5},(_,index)=>({id:'mine-'+index,type:'mine' as const})),{id:'power',type:'solar',sealed:true}];
    planet.priorities={farm:5,mine:4,solar:0};
    state.factions.aurora.resources={energy:0,food:units(5000),minerals:units(5000),alloys:0};
    const world=scriptKnowledge(state,'aurora'),generated=candidateFacts(world,'aurora',true);
    const candidate=(id:string,actions:ScriptCandidate['actions']):ScriptCandidate=>({id,label:id,kind:'status',target:planet.id,actions,priority:0,value:20,risk:0,reason:'restart/staff dependency',evidenceDays:[0],progress:'',deadline:12000,economic:true,exclusive:[id],fingerprint:id,tasks:[]});
    const choices=[candidate('restart',[{type:'set_structure_status',args:{planetId:planet.id,structureId:'power',sealed:false}}]),candidate('staff',[{type:'set_jobs',args:{planetId:planet.id,structureType:'solar',priority:5}}])];
    const decision=await adaptiveV3Decision(world,'aurora',undefined,{candidates:async()=>({...generated,candidates:choices})});
    expect(decision.actions.some(action=>action.type==='set_structure_status')).toBe(true);
    expect(decision.actions.some(action=>action.type==='set_jobs')).toBe(true);
    expect(decision.scriptReport!.search!.depth).toBeGreaterThanOrEqual(2);
  },30000);
  it('responsibility expires on schedule and conditional success is separate',()=>{
    const state=game(),own=state.factions.aurora;own.civilization={choice:'militarist',establishedDay:0};own.responsibility=newResponsibility(0);state.day=730;
    const success=structuredClone(state);
    forecastResponsibility(state,'aurora',{actionable:true});
    forecastResponsibility(success,'aurora',{actionable:true,successDay:720});
    expect(own.responsibility.dissatisfaction).toBe(.5);
    expect(success.factions.aurora.responsibility!.dissatisfaction).toBe(0);
    expect(success.factions.aurora.responsibility!.satisfiedUntil).toBe(2520);
  });
  it('draft deltas reproduce paid orders without modifying their prefix',()=>{
    const state=game(),before=stateHash(state),stage=new StagingArea(state,'aurora'),planet=state.systems.find(system=>system.ownerId==='aurora')!.planets[0];
    expect(stage.execute('queue_ships',{planetId:planet.id,shipType:'destroyer',count:1}).ok).toBe(true);
    const restored=applyStateChanges(state,stateChanges(state,stage.draft));
    expect(stateHash(restored)).toBe(stateHash(stage.draft));expect(stateHash(state)).toBe(before);
    const source={items:[{id:'first'}],optional:1};
    const target={items:[{id:'first'},{id:'second'}],missing:undefined};
    expect(applyStateChanges(source,stateChanges(source,target))).toEqual(target);
  });
  it('fresh timestamps alone do not reset a stalled campaign',()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!,target=state.systems.find(system=>home.neighbors.includes(system.id))!;
    target.ownerId='umbra';target.base={hull:50};
    state.factions.aurora.militaryIntel![target.id]={day:0,source:'lrs',ownerId:'umbra',base:target.base,fleets:[]};
    const candidate:ScriptCandidate={id:'prepare-test',label:'prepare',kind:'prepare',target:target.id,actions:[{type:'prepare_conquest',args:{factionId:'umbra'}}],priority:0,value:100,risk:0,reason:'fixture',evidenceDays:[0],progress:'',deadline:12000,economic:true,exclusive:['conquest'],fingerprint:'',tasks:[]};
    const memory:ScriptMemory={version:'adaptive-v3',goal:null,tasks:[],failures:[]};
    campaignCandidates(state,'aurora',memory,[candidate]);
    state.day=200;state.round=2;state.factions.aurora.militaryIntel![target.id].day=200;
    campaignCandidates(state,'aurora',memory,[candidate]);
    expect(memory.campaign!.lastProgressRound).toBe(0);
    expect(memory.campaign!.blockers.join()).toContain('两轮无实际进展');
  });
  it('profiles persist in hash, runtime configuration stays outside state',()=>{
    const state=game(),hash=stateHash(state);
    expect(computeConfig(4,{computeWorkers:0,planningCacheMiB:0})).toMatchObject({planningWorkers:0,forecastWorkers:0});
    expect(stateHash(state)).toBe(hash);
    state.config.scriptSearchProfile='deep';expect(stateHash(state)).not.toBe(hash);
    expect(ADAPTIVE_V3.profiles.standard).toEqual({candidates:256,width:4,depth:3,evaluations:256,forecasts:48});
  });
  it('governance detects a mid-horizon collapse without changing legacy forecast semantics',()=>{
    const state=game(),own=state.factions.aurora;
    own.resources={energy:0,minerals:0,food:0,alloys:0};own.unity=1000;
    const hash=stateHash(state);
    const legacy=economicForecast(state,'aurora',[300]);
    const modern=economicForecast(state,'aurora',[300],{actionable:false});
    expect(legacy.horizons[0].governance).toBeUndefined();
    expect(modern.horizons[0].governance!.minimumUnity).toBeLessThan(60);
    expect(modern.horizons[0].governance!.lowUnityDays).toBeGreaterThan(0);
    expect(stateHash(state)).toBe(hash);
  });
  it('ownership failures ignore inventory and military-only refreshes',()=>{
    const state=game(),actor='aurora',home=state.systems.find(system=>system.ownerId===actor)!;
    const actions=[{type:'build_starbase',args:{systemId:home.id}}];
    const before=v3FailureDependency(state,actor,actions,'归属失败');
    state.factions[actor].resources.minerals+=units(100);
    expect(v3FailureDependency(state,actor,actions,'归属失败')).toBe(before);
    state.factions[actor].intel[home.id].day++;
    expect(v3FailureDependency(state,actor,actions,'归属失败')).not.toBe(before);
  });
  it('mineral-funded retry ignores unrelated food and energy income',()=>{
    const state=game(),home=state.systems.find(system=>system.ownerId==='aurora')!;
    const actions=[{type:'build_starbase',args:{systemId:home.id}}];
    const before=v3FailureDependency(state,'aurora',actions,'资源条件未满足');
    state.factions.aurora.resources.food+=units(50);
    state.factions.aurora.resources.energy+=units(50);
    expect(v3FailureDependency(state,'aurora',actions,'资源条件未满足')).toBe(before);
    state.factions.aurora.resources.minerals+=units(50);
    expect(v3FailureDependency(state,'aurora',actions,'资源条件未满足')).not.toBe(before);
  });
  it('cache eviction preserves results and bounds retained bytes',()=>{
    const cache=new PlanningCache<number[]>(50);
    cache.set('first',[1,2,3]);expect(cache.get('first')).toEqual([1,2,3]);
    cache.set('second',Array(100).fill(0));expect(cache.get('second')).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(50);cache.clear();expect(cache.bytes).toBe(0);
  });
  it('combination search stays in cumulative budgets and has no hidden-state dependency',async()=>{
    const state=game(),changed=structuredClone(state),hash=stateHash(state);
    changed.factions.umbra.resources.food=0;
    changed.systems.find(system=>system.ownerId==='umbra')!.planets[0].population=100;
    const first=await adaptiveV3Decision(scriptKnowledge(state,'aurora'),'aurora',undefined);
    const second=await adaptiveV3Decision(scriptKnowledge(changed,'aurora'),'aurora',undefined);
    expect(second.actions).toEqual(first.actions);expect(second.scriptMemory).toEqual(first.scriptMemory);
    expect(second.summary).toBe(first.summary);
    expect(first.scriptReport!.forecasts).toBeLessThanOrEqual(48);
    expect(first.scriptReport!.search!.evaluations).toBeLessThanOrEqual(256);
    expect(first.actions.length).toBeLessThanOrEqual(48);expect(first.metrics.requests).toBe(0);
    expect(stateHash(state)).toBe(hash);
  },120000);
  it('serial and workers use identical fixed ordering and memory',async()=>{
    const state=game();state.config.maxRounds=3;
    const maximum=Math.min(64,Math.max(0,availableParallelism()-2));
    let reference:unknown,worldHash:string|undefined;
    for(const count of [...new Set([0,2,8,maximum])].filter(count=>count<=maximum)) {
      const pool=new PlanningPool(4,{v3:true,computeWorkers:count,planningCacheMiB:count===8?1:count?16:0}),simulation=new SimulationPool(count?2:0);
      try {
        const decisions=await pool.decide(JSON.parse(JSON.stringify(state)));
        const comparable=Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,{actions:decision.actions,memory:decision.scriptMemory}]));
        if(reference)expect(comparable).toEqual(reference);else reference=comparable;
        const next=await advanceRound(state,simulation,Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,decision.actions])));commitScriptMemory(next,decisions);
        if(worldHash)expect(stateHash(next)).toBe(worldHash);else worldHash=stateHash(next);
      } finally {await pool.close();await simulation.close();}
    }
  },180000);
  it('pause rejects the entire pending round without touching state',async()=>{
    const state=game(),before=stateHash(state),pool=new PlanningPool(4,{v3:true,computeWorkers:0,planningCacheMiB:0}),abort=new AbortController();
    abort.abort();
    try {await expect(pool.decide(state,abort.signal)).rejects.toThrow();expect(stateHash(state)).toBe(before);} finally {await pool.close();}
  });
  it('worker failure rejects all faction results and preserves the boundary',async()=>{
    if(availableParallelism()<4)return;
    const state=game(),before=stateHash(state),pool=new PlanningPool(4,{v3:true,computeWorkers:2,planningCacheMiB:1});
    const computation=pool.decide(state);
    const worker=(pool as unknown as {planning:{workers:{worker:{terminate:()=>Promise<number>}}[]}}).planning.workers[0].worker;
    const rejected=expect(computation).rejects.toThrow();
    await worker.terminate();await rejected;
    expect(stateHash(state)).toBe(before);expect(pool.closed).toBe(true);await pool.close();
  },30000);
  it('pause during worker planning discards the whole uncommitted round',async()=>{
    if(availableParallelism()<4)return;
    const state=game(),before=stateHash(state),pool=new PlanningPool(4,{v3:true,computeWorkers:2,planningCacheMiB:1}),abort=new AbortController();
    const computation=pool.decide(state,abort.signal);
    const rejected=expect(computation).rejects.toThrow();
    const timer=setTimeout(()=>abort.abort(),100);
    try {await rejected;expect(stateHash(state)).toBe(before);expect(pool.closed).toBe(true);}
    finally {clearTimeout(timer);await pool.close();}
  },30000);
  it('a failed batch does not retain earlier changes',()=>{
    const state=game(),stage=new StagingArea(state,'aurora'),hash=stateHash(stage.draft);
    const planet=state.systems.find(system=>system.ownerId==='aurora')!.planets[0];
    const result=stage.execute('set_structures_status',{structures:[{planetId:planet.id,structureId:planet.structures[0].id,sealed:true},{planetId:planet.id,structureId:'missing',sealed:true}]});
    expect(result.ok).toBe(false);expect(stateHash(stage.draft)).toBe(hash);expect(stage.actions).toHaveLength(0);
  });
});
