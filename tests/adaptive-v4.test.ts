import { availableParallelism } from 'node:os';
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { ADAPTIVE_V4 } from '../src/shared/adaptive-v4.js';
import type { MilitaryOptionV4 } from '../src/shared/adaptive-v4.js';
import type { ScriptMemory } from '../src/shared/adaptive.js';
import { createGame } from '../src/sim/world.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { adaptiveV4Decision, explainConstraintsV4 } from '../src/sim/adaptive-v4.js';
import { candidateFacts } from '../src/sim/adaptive-candidates.js';
import { currentRiskV4, recoveryCandidatesV4, economicCandidatesV4 } from '../src/sim/adaptive-v4-economy.js';
import { positionValueV4 } from '../src/sim/adaptive-v4-values.js';
import { campaignProgressV4, cleanTasksV4, tacticalV4, militaryActionV4, militaryPlansV4 } from '../src/sim/adaptive-v4-military.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { economicForecast } from '../src/sim/forecast.js';
import { StagingArea } from '../src/sim/actions.js';
import { stateHash } from '../src/sim/math.js';
import { relationKey } from '../src/shared/diplomacy.js';

const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4',scriptSearchProfile:'standard'},'v4-fixture');

describe('adaptive-v4 crisis and campaigns',()=>{
  it('reports command-time resource constraints without counting later income',()=>{
    const stop=explainConstraintsV4(['可用资源不足，已排队项目的资源也已预留'],{energy:units(1500),food:units(267),minerals:units(17.142),alloys:units(6.15)});
    expect(stop).toContain('矿物17.142');expect(stop).toContain('未计随后生产');expect(stop).not.toBe('无正收益');
    expect(explainConstraintsV4(['同前缀比较收益不足'],{energy:0,food:0,minerals:units(1000)})).toBe('无正收益');
  });
  it('compares 500-day colonization and exploration in a normal 120-round opening',async()=>{
    const state=fixture();state.config.maxRounds=120;
    const known=scriptKnowledge(state,'umbra'),decision=await adaptiveV4Decision(known,'umbra',undefined);
    expect(decision.actions.some(action=>action.type==='survey_system')).toBe(true);
    expect(decision.actions.some(action=>action.type==='colonize_planet')).toBe(true);
    expect(decision.scriptReport!.forecasts).toBeLessThanOrEqual(48);
  },120000);
  it('does not reward repeated patrols on already observed unsurveyed systems',()=>{
    const known=scriptKnowledge(fixture(),'umbra');
    const before=candidateFacts(known,'umbra',true,256,true),scout=before.candidates.find(c=>c.kind==='scout')!;
    expect(scout).toBeDefined();
    const target=known.systems.find(s=>s.id===scout.target)!;
    const accepted=economicCandidatesV4(known,'umbra',[scout])[0];
    expect(accepted).toBeDefined();
    expect(Math.hypot(Number(accepted.actions[0].args.x)-500,Number(accepted.actions[0].args.y)-500)).toBeGreaterThan(80);
    known.factions.umbra.militaryIntel![target.id]={day:known.day,source:'local',ownerId:null,base:null,fleets:[]};
    expect(economicCandidatesV4(known,'umbra',[scout])).toHaveLength(0);
    expect(positionValueV4(known,'umbra',12000).functional).toBe(0);
  });
  it('compares recapturing an occupied home even after the occupying fleet has left',()=>{
    const state=fixture(),actor='umbra',home=state.systems.find(s=>s.ownerId===actor)!;
    home.controllerId='aurora';state.relations[relationKey(actor,'aurora')].status='war';
    state.fleets=state.fleets.filter(f=>f.ownerId===actor);
    const known=scriptKnowledge(state,actor),facts=candidateFacts(known,actor,true,256,true);
    const plans=militaryPlansV4(known,actor,facts,{version:'adaptive-v4',goal:null,tasks:[],failures:[]});
    expect(plans.some(p=>p.mode==='defend'&&p.target===home.id&&p.knownPower>=home.base!.hull)).toBe(true);
  });
  it('projects paid bases only for V4 and never mutates the source checkpoint',()=>{
    const state=fixture(),actor='umbra',home=state.systems.find(s=>s.ownerId===actor)!,target=state.systems.find(s=>home.neighbors.includes(s.id)&&!s.ownerId)!;
    state.factions[actor].surveyed.push(target.id);state.factions[actor].intel[target.id]={day:0,system:structuredClone(target),fleets:[]};
    const stage=new StagingArea(state,actor);expect(stage.execute('build_starbase',{systemId:target.id}).ok).toBe(true);
    const hash=stateHash(stage.draft),old=economicForecast(stage.draft,actor,[720],{actionable:false});
    const next=economicForecast(stage.draft,actor,[720],{actionable:false,version:'v4'});
    expect(old.completedProjects.some(p=>p.kind==='base')).toBe(false);
    expect(next.completedProjects.some(p=>p.kind==='base')).toBe(true);
    expect(next.horizons[0].governance!.score).toBeGreaterThan(old.horizons[0].governance!.score+80);
    expect(stateHash(stage.draft)).toBe(hash);
  });
  it('includes working facilities in crisis shutdown and preserves the source world',()=>{
    const state=fixture(),own=state.factions.aurora,home=state.systems.find(system=>system.id===own.homeSystemId)!,planet=home.planets[0];
    planet.population=20;planet.structures.push({id:'working-foundry',type:'foundry'});delete planet.operation;
    own.resources={energy:0,food:0,minerals:units(1000),alloys:units(1000)};
    const before=stateHash(state),known=scriptKnowledge(state,'aurora'),base=candidateFacts(known,'aurora',true,256,true);
    const candidates=recoveryCandidatesV4(known,'aurora',base.candidates);
    expect(candidates.some(candidate=>candidate.actions.some(action=>action.type==='set_structure_status'&&action.args.structureId==='working-foundry'&&action.args.sealed===true))).toBe(true);
    expect(currentRiskV4(known,'aurora').value).toBeGreaterThan(0);
    expect(stateHash(state)).toBe(before);
  });
  it('distinguishes deficit severity even when both plans stay short of power',()=>{
    const state=fixture(),own=state.factions.aurora;
    own.resources={energy:0,food:units(5000),minerals:units(5000),alloys:0};
    own.shortages.energy=true;
    const home=state.systems.find(system=>system.id===own.homeSystemId)!,planet=home.planets[0];
    planet.population=20;planet.structures=[{id:'solar',type:'solar'},{id:'farm',type:'farm'},{id:'foundry',type:'foundry'},{id:'yard',type:'shipyard'}];delete planet.operation;
    const before=currentRiskV4(state,'aurora',300);
    planet.structures.find(structure=>structure.id==='foundry')!.sealed=true;
    const after=currentRiskV4(state,'aurora',300);
    expect(after.value).toBeLessThan(before.value);
  });
  it('uses combat losses and enemy destroyed score, not enemy hull as own cost',()=>{
    const state=fixture(),actor='aurora',opponent='umbra',home=state.systems.find(system=>system.ownerId===actor)!,target=state.systems.find(system=>system.ownerId===opponent)!;
    const own=state.fleets.find(fleet=>fleet.ownerId===actor)!,enemy=state.fleets.find(fleet=>fleet.ownerId===opponent)!;
    own.systemId=target.id;own.position={x:500,y:500};own.ships=Array.from({length:60},(_,index)=>({id:'own-'+index,type:'destroyer',hull:10}));
    enemy.systemId=target.id;enemy.position={x:500,y:500};enemy.ships=Array.from({length:10},(_,index)=>({id:'enemy-'+index,type:'destroyer',hull:10}));target.base={hull:100};
    state.factions[actor].militaryIntel![target.id]={day:0,source:'lrs',ownerId:opponent,base:target.base,fleets:[structuredClone(enemy)]};
    state.relations[relationKey(actor,opponent)].status='war';
    const option:MilitaryOptionV4={id:'attack',opponent,target:target.id,warType:'total',mode:'concentrated',fleetIds:[own.id],staging:home.id,arrival:0,expectedDay:200,knownPower:200,availablePower:600,unknown:false,intelDays:[0],scenarios:[],territory:300,duty:0,maintenance:0,value:0,blockers:[],ready:true,preparation:false};
    const before=stateHash(state),result=tacticalV4(scriptKnowledge(state,actor),{actor,option});
    expect(result.scenarios).toHaveLength(3);expect(result.scenarios[0].won).toBe(true);
    expect(result.scenarios[0].enemyLoss).toBe(50);expect(result.scenarios[0].ownLoss).toBeLessThan(100);
    expect(result.value).toBeGreaterThan(0);expect(stateHash(state)).toBe(before);
  });
  it('launches an executable favorable total war and merges concentrated ships before advancing',()=>{
    const state=fixture(),actor='aurora',opponent='umbra',fleet=state.fleets.find(fleet=>fleet.ownerId===actor)!,target=state.systems.find(system=>system.ownerId===opponent)!;
    const home=state.systems.find(system=>system.id===fleet.systemId)!;
    home.neighbors.push(target.id);target.neighbors.push(home.id);home.gates[target.id]={x:950,y:500};target.gates[home.id]={x:50,y:500};
    state.relations[relationKey(actor,opponent)].status='peace';state.relations[relationKey(actor,opponent)].confirmed=[actor,opponent];
    state.factions[actor].surveyed.push(target.id);state.factions[actor].intel[target.id]={day:state.day,system:structuredClone(target),fleets:[]};
    state.conquests=[{id:'ready',actor,target:opponent,reason:'fixture',startedDay:-360,readyDay:0,freePeaceDays:0}];
    const force={...structuredClone(fleet),id:'second'};force.ships=force.ships.map(ship=>({...ship,id:'second-'+ship.id}));state.fleets.push(force);
    const facts=candidateFacts(scriptKnowledge(state,actor),actor,true,256,true),comparison=facts.facts.comparison.wars.find(war=>war.target===opponent)!;
    expect(comparison.options.some(option=>option.warType==='total'&&option.allowed)).toBe(true);
    const option:MilitaryOptionV4={id:'test',opponent,target:target.id,warType:'total',mode:'concentrated',fleetIds:[fleet.id,force.id],staging:fleet.systemId,arrival:100,expectedDay:300,knownPower:10,availablePower:200,unknown:false,intelDays:[0],scenarios:[],territory:300,duty:0,maintenance:0,value:200,blockers:[],ready:true,preparation:false};
    const plan=militaryActionV4(state,actor,option,facts)!;
    expect(plan.actions.map(action=>action.type)).toEqual(['declare_war','merge_fleets','move_fleet']);
    expect(plan.actions.at(-1)!.args.fleetId).toBe(fleet.id);
    const draft=new StagingArea(state,actor);for(const action of plan.actions)expect(draft.execute(action.type,action.args).ok).toBe(true);
    option.unknown=true;state.relations[relationKey(actor,opponent)].status='contact';
    expect(militaryActionV4(state,actor,option,facts)).toBeNull();
  });
  it('expires stale fleet tasks and does not count unrelated shipbuilding as campaign progress',()=>{
    const state=fixture(),own=state.fleets.find(fleet=>fleet.ownerId==='aurora')!,target=state.systems.find(system=>system.ownerId==='umbra')!;
    const memory:ScriptMemory={version:'adaptive-v4',goal:null,failures:[],tasks:[{fleetId:'gone',role:'defend',target:target.id},{fleetId:own.id,role:'hold',target:target.id,warId:'ended'}],operation:{id:'campaign',opponent:'umbra',targets:[target.id],warType:'total',stage:'assemble',fleetIds:[own.id],staging:own.systemId,createdDay:0,deadline:1000,progress:'',lastProgressRound:0,value:100,reserve:{minerals:100},blockers:[],nextStep:'assemble',launchDay:null,ready:false}};
    cleanTasksV4(state,'aurora',memory);expect(memory.tasks).toHaveLength(0);
    campaignProgressV4(state,'aurora',memory);const progress=memory.operation!.progress;
    state.fleets.push({...structuredClone(own),id:'unrelated',ships:[{id:'new',type:'destroyer',hull:10}]});state.round=2;
    campaignProgressV4(state,'aurora',memory);
    expect(memory.operation!.progress).toBe(progress);expect(memory.operation!.stage).toBe('exit');expect(memory.operation!.reserve).toEqual({});
  });
  it('adds V4 severity only when requested and keeps forecast reads isolated',()=>{
    const state=fixture(),before=stateHash(state);
    const old=economicForecast(state,'aurora',[100],{actionable:false});
    const next=economicForecast(state,'aurora',[100],{actionable:false,version:'v4'});
    expect(old.trajectory!.at(-1)!.risk).toBeUndefined();expect(next.trajectory!.at(-1)!.risk).toBeDefined();expect(stateHash(state)).toBe(before);
  });
  it('keeps 48/49 capacity and resource rollback in the existing transaction',()=>{
    const state=fixture(),fleet=state.fleets.find(fleet=>fleet.ownerId==='aurora')!,stage=new StagingArea(state,'aurora');
    for(let index=0;index<48;index++)expect(stage.execute('move_fleet',{fleetId:fleet.id,systemId:fleet.systemId,x:600+index,y:500,targetFleetId:null}).ok).toBe(true);
    const hash=stateHash(stage.draft);expect(stage.execute('move_fleet',{fleetId:fleet.id,systemId:fleet.systemId,x:700,y:500,targetFleetId:null}).ok).toBe(false);expect(stateHash(stage.draft)).toBe(hash);
  });
  it('keeps deterministic actions and memory with filtered knowledge and planning workers',async()=>{
    const state=fixture();state.config.maxRounds=2;
    console.info('Worker determinism coverage (requested 0/2/8; CPU-limited hosts do not cover larger pools):', [0,2,8].map(n=>Math.min(n,Math.max(0,availableParallelism()-2))));
    const serial=new PlanningPool(1,{v3:true,computeWorkers:0,planningCacheMiB:0});
    const parallel=new PlanningPool(1,{v3:true,computeWorkers:Math.min(2,Math.max(0,availableParallelism()-2)),planningCacheMiB:16});
    const eight=new PlanningPool(1,{v3:true,computeWorkers:Math.min(8,Math.max(0,availableParallelism()-2)),planningCacheMiB:128});
    try {
      const before=stateHash(state),first=await serial.decide(state,undefined,undefined,undefined,['aurora']);
      const second=await parallel.decide(state,undefined,undefined,undefined,['aurora']);
      expect(second.aurora.actions).toEqual(first.aurora.actions);expect(second.aurora.scriptMemory).toEqual(first.aurora.scriptMemory);
      const thirdMode=await eight.decide(JSON.parse(JSON.stringify(state)),undefined,undefined,undefined,['aurora']);
      expect(thirdMode.aurora.actions).toEqual(first.aurora.actions);expect(thirdMode.aurora.scriptMemory).toEqual(first.aurora.scriptMemory);
      state.factions.umbra.resources.minerals=units(99999);
      const third=await serial.decide(state,undefined,undefined,undefined,['aurora']);expect(third.aurora.actions).toEqual(first.aurora.actions);
      expect(first.aurora.scriptReport!.search!.evaluations).toBeLessThanOrEqual(ADAPTIVE_V4.profiles.standard.evaluations);
      expect(first.aurora.scriptReport!.forecasts).toBeLessThanOrEqual(ADAPTIVE_V4.profiles.standard.forecasts);
      expect(before).not.toBe(stateHash(state));
    } finally {await serial.close();await parallel.close();await eight.close();}
  },120000);
  it('chooses a real crisis repair, rather than merely listing shutdown candidates',async()=>{
    const state=fixture(),own=state.factions.aurora,planet=state.systems.find(system=>system.id===own.homeSystemId)!.planets[0];
    state.config.maxRounds=8;planet.population=20;
    planet.structures=[{id:'power',type:'solar'},{id:'food',type:'farm'},{id:'ore',type:'mine'},{id:'smelter',type:'foundry'},{id:'yard',type:'shipyard'}];delete planet.operation;
    own.resources={energy:0,food:units(10),minerals:units(200),alloys:units(300)};own.shortages.energy=true;
    const decision=await adaptiveV4Decision(scriptKnowledge(state,'aurora'),'aurora',undefined);
    expect(decision.actions.length).toBeGreaterThan(0);
    expect(decision.scriptReport!.v4!.finalRisk.value).toBeLessThan(decision.scriptReport!.v4!.risk.value);
    expect(decision.scriptReport!.v4!.crisisChecked).toBe(true);
  },120000);
});
