import { fallbackRules, fleetDemand, funding } from '../src/sim/sras11-experts.js';
import { campaignDependency } from '../src/sim/sras11-response.js';
import { describe,it,expect } from 'vitest';
import { availableParallelism } from 'node:os';
import { createGame } from '../src/sim/world.js';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { SRAS, srasStage, type SrasMemory } from '../src/shared/sras11.js';
import { srasDecision, noChange, scheduledRisk } from '../src/sim/sras11.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { validateScriptPlan, commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { stateHash } from '../src/sim/math.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { ledger, failureDependency, knownDefense } from '../src/sim/sras11-rules.js';
import { economicRules } from '../src/sim/sras11-economy.js';
import { militaryRules, refreshTasks } from '../src/sim/sras11-military.js';
import { relationKey } from '../src/shared/diplomacy.js';
import { configureSeats, validateControllers } from '../src/shared/controllers.js';
import type { MatchConfig } from '../src/shared/types.js';
import { StagingArea } from '../src/sim/actions.js';
import { support } from '../src/shared/industry.js';
import {conflictKeys,intentKeys,responseRules,situation,threatTable,candidateDependency} from '../src/sim/sras11-response.js';

const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'sras-v1.1',maxRounds:120},'sras-fixture');
const memory=():SrasMemory=>({revision:SRAS.revision,stage:'exploration',tasks:[],failures:[]});
describe('SRAS V1.1 task rules',()=>{
  it('does not label prior-round task acceptance as a current final-validation removal',async()=>{
    const {s,a,m}=campaignFixture();m.tasks[0].stage='recon';m.tasks[0].plannedGroup='prior-round-group';m.tasks[0].status='executed';s.factions[a].militaryIntel={};s.factions[a].intel={};
    const d=await srasDecision(scriptKnowledge(s,a),a,{version:'sras-v1.1',goal:null,tasks:[],failures:[],sras:m});
    expect(d.scriptMemory!.sras!.tasks.flatMap(t=>t.blockers)).not.toContain('planned action group removed during final validation');
  });

  it('checks paid reconnaissance only on operated colonies, not uncolonized planets',()=>{
    const {s,a,m}=campaignFixture();m.tasks[0].stage='recon';
    expect(s.systems.some(h=>h.ownerId===a&&h.planets.some(p=>p.ownerId===null))).toBe(true);
    expect(()=>refreshTasks(s,a,m)).not.toThrow();
  });

  it('does not dismantle production to fix fully paid but unreachable welfare',()=>{
    const s=fixture(),f=s.factions.aurora;
    f.resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:units(1000)};
    f.welfare!.last={day:0,population:10,reachablePopulation:8,due:{energy:1000,food:1000,minerals:1000},deliverable:{energy:800,food:800,minerals:800},paid:{energy:800,food:800,minerals:800},fraction:.8,aid:{energy:0,food:0,minerals:0},selfPaid:{energy:800,food:800,minerals:800},reasons:[]};
    const rules=economicRules(s,'aurora',memory());
    expect(rules.some(g=>g.expert==='crisis'&&g.actions.some(x=>x.type==='set_structure_status'&&x.args.sealed===true))).toBe(false);
    expect(situation(s,'aurora').flags).toContain('welfare-delivery-blocked');
  });

  it('does not retry local jobs on unrelated inventory spending',()=>{
    const s=fixture(),p=s.systems.flatMap(h=>h.planets).find(p=>p.ownerId==='aurora')!;
    const c={id:'local',expert:'economy' as const,priority:3,rank:1,actions:[{type:'set_jobs',args:{planetId:p.id,structureType:'mine',priority:5}}],reason:'test',dependencies:[]};
    const before=candidateDependency(s,'aurora',c);s.factions.aurora.resources.minerals+=units(1234);expect(candidateDependency(s,'aurora',c)).toBe(before);
  });
  it('turns fallback idle labor into actual production tasks',()=>{
    const s=fixture(),p=s.systems.flatMap(h=>h.planets).find(p=>p.ownerId==='aurora')!;p.population=16;p.structures=[];
    expect(fallbackRules(s,'aurora',memory()).some(g=>g.actions.some(x=>x.type==='build_structure'))).toBe(true);
  });
  it('stops discretionary ship orders once task demand is funded',()=>{
    const s=fixture(),f=s.fleets.find(f=>f.ownerId==='aurora')!;f.ships=Array.from({length:10},(_,i)=>({id:'strong-'+i,type:'dreadnought' as const,hull:1000}));
    expect(fleetDemand(s,'aurora',memory()).gap).toBe(0);
    expect(economicRules(s,'aurora',memory()).some(g=>g.actions.some(x=>x.type==='queue_ships'))).toBe(false);
  });
  it('counterattacks in a defensive total war without own declared goals',()=>{
    const {s,a,target,m}=campaignFixture();m.tasks=[];s.wars![0].goals={};s.wars![0].type='total';s.wars![0].attackers=['umbra'];
    const rules=militaryRules(s,a,m);expect(m.tasks.some(t=>t.expert==='campaign'&&t.target===target.id)).toBe(true);
    expect(rules.some(g=>g.actions.some(x=>x.type==='move_fleet'&&x.args.systemId===target.id))).toBe(true);
  });
  it('does not unlock campaign cooldown for unrelated remote ship construction',()=>{
    const {s,a,target,fleet}=campaignFixture();const before=campaignDependency(s,a,target.id);
    const extra=structuredClone(fleet);extra.id='remote';extra.systemId=s.systems.find(h=>!target.neighbors.includes(h.id)&&h.id!==target.id)!.id;s.fleets.push(extra);
    expect(campaignDependency(s,a,target.id)).toBe(before);
  });
  it('provides concrete funding gaps rather than spending previews on unaffordable construction',()=>{
    const s=fixture();s.factions.aurora.resources.minerals=0;
    const p=s.systems.flatMap(h=>h.planets).find(p=>p.ownerId==='aurora')!;
    const f=funding(s,'aurora',[{type:'build_structure',args:{planetId:p.id,structureType:'mine'}}]);expect(f.gaps[0].gap).toBeGreaterThan(0);
  });

  it('shares an investment conflict key between cancellation and replacement',()=>{
    const s=fixture(),stage=new StagingArea(s,'aurora'),p=s.systems.flatMap(h=>h.planets).find(p=>p.ownerId==='aurora')!;
    expect(stage.execute('queue_ships',{planetId:p.id,shipType:'destroyer',count:1}).ok).toBe(true);
    const q=stage.draft.systems.flatMap(h=>h.projects).find(q=>q.kind==='ship')!;
    const cancelled=intentKeys(stage.draft,{type:'cancel_order',args:{projectId:q.id}});
    expect(intentKeys(stage.draft,{type:'queue_ships',args:{planetId:p.id,shipType:'destroyer',count:1}}).some(k=>cancelled.includes(k))).toBe(true);
  });
  it('never seals/restarts or reprioritizes the same object twice in a crisis turn',async()=>{
    const s=fixture();s.factions.aurora.resources.energy=0;s.factions.aurora.resources.food=0;s.factions.aurora.shortages.energy=true;
    const d=await srasDecision(scriptKnowledge(s,'aurora'),'aurora',undefined);
    const keys=d.actions.flatMap(conflictKeys);expect(new Set(keys).size).toBe(keys.length);
    expect(d.scriptReport!.sras!.fallback).toHaveLength(9);
    expect(Object.values(d.scriptReport!.sras!.budget!).reduce((n,x)=>n+x,0)).toBe(d.scriptReport!.sras!.previews);
  });
  it('detects lost ship production and generates a survival rebuild or peace response',()=>{
    const {s,a,home,m}=campaignFixture();s.fleets=s.fleets.filter(f=>f.ownerId!==a);
    for(const h of s.systems)for(const p of h.planets)if(p.ownerId===a)p.structures=p.structures.filter(b=>b.type!=='shipyard');
    expect(situation(s,a).flags).toContain('core-capacity-lost');
    const rules=responseRules(s,a,m);
    expect(rules.some(g=>g.actions.some(x=>x.type==='build_structure'&&x.args.structureType==='shipyard'||x.type==='propose_peace'))).toBe(true);
  });
  it('counts an enemy fleet against one reachable threatened home and clears lost defense',()=>{
    const {s,a,home,fleet,m}=campaignFixture();const enemy=structuredClone(fleet);enemy.id='invader';enemy.ownerId='umbra';s.fleets.push(enemy);
    const other=s.systems.find(x=>x.id!==home.id&&home.neighbors.includes(x.id))!;other.ownerId=a;
    const assigned=threatTable(s,a).flatMap(x=>x.fleets);expect(assigned.filter(id=>id==='invader')).toHaveLength(1);
    m.tasks.push({id:'lost',expert:'defense',target:other.id,assets:[fleet.id],reserve:{},stage:'assemble',deadline:9999,evidence:'',lastProgressRound:0,next:'hold',blockers:[],exit:''});other.ownerId='umbra';
    refreshTasks(s,a,m);expect(m.tasks.find(t=>t.id==='lost')!.stage).toBe('exit');expect(m.tasks.find(t=>t.id==='lost')!.assets).toEqual([]);
  });
  it('does not invalidate a rejected local jobs candidate for unrelated fleet movement',()=>{
    const s=fixture(),p=s.systems.flatMap(h=>h.planets).find(p=>p.ownerId==='aurora')!;
    const c={id:'jobs',expert:'economy' as const,priority:3,rank:1,actions:[{type:'set_jobs',args:{planetId:p.id,structureType:'mine',priority:5}}],reason:'test',dependencies:[]};
    const before=candidateDependency(s,'aurora',c);s.fleets.find(f=>f.ownerId==='aurora')!.position.x+=50;
    expect(candidateDependency(s,'aurora',c)).toBe(before);
  });
  function campaignFixture() {
    const s=fixture(),a='aurora',home=s.systems.find(x=>x.ownerId===a)!,target=s.systems.find(x=>x.ownerId==='umbra')!;
    home.neighbors.push(target.id);target.neighbors.push(home.id);home.gates[target.id]={x:600,y:500};target.gates[home.id]={x:400,y:500};
    s.factions[a].resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:units(10000)};
    s.fleets=s.fleets.filter(f=>f.ownerId!=='umbra');
    const fleet=s.fleets.find(f=>f.ownerId===a)!;fleet.ships=[{id:'strong',type:'dreadnought',hull:1000}];fleet.systemId=home.id;fleet.order=null;fleet.transit=null;
    target.base={hull:20};s.factions[a].militaryIntel={[target.id]:{day:0,source:'lrs',ownerId:'umbra',base:{hull:20},fleets:[]}};
    s.relations[relationKey(a,'umbra')].status='war';
    s.wars=[{id:'bound-war',type:'limited',factions:[a,'umbra'],attackers:[a],startedDay:0,startedRound:0,reasons:{},goals:{[a]:[{type:'limited',systemId:target.id,heldDays:0}]},fatigue:{[a]:0,umbra:0},openingValue:{},lossWindow:0,lossUsed:{}}];
    const m=memory();m.tasks.push({id:'campaign',expert:'campaign',target:target.id,opponent:'umbra',warId:'bound-war',assets:[fleet.id],reserve:{},stage:'assemble',rally:home.id,deadline:10000,evidence:'',lastProgressRound:0,next:'assemble',blockers:[],exit:''});
    return {s,a,home,target,fleet,m};
  }
  it('retains assembling assets across prefixes and waits for every arrival before launch',()=>{
    const {s,a,home,fleet,m}=campaignFixture();
    const reinforcement=structuredClone(fleet);reinforcement.id='reinforcement';reinforcement.systemId=null;reinforcement.transit={from:home.neighbors[0],to:home.id,remainingDays:60};
    s.fleets.push(reinforcement);m.tasks[0].assets.push(reinforcement.id);
    for(let round=0;round<2;round++){
      s.round=round;reinforcement.transit!.remainingDays-=10;refreshTasks(s,a,m);
      const rules=militaryRules(s,a,m);
      expect(m.tasks[0].assets).toContain(reinforcement.id);expect(m.tasks[0].stage).toBe('assemble');
      expect(rules.some(g=>g.actions.some(x=>x.type==='declare_war'||x.type==='merge_fleets'||x.type==='move_fleet'&&x.args.fleetId===fleet.id))).toBe(false);
    }
    reinforcement.systemId=home.id;reinforcement.transit=null;
    expect(militaryRules(s,a,m).some(g=>g.actions.some(x=>x.type==='merge_fleets'))).toBe(true);
  });
  it('gives defense exclusive assets and retains ordered defenders on subsequent prefixes',()=>{
    const {s,a,home,fleet,m}=campaignFixture();const enemy=structuredClone(fleet);enemy.id='invader';enemy.ownerId='umbra';s.fleets.push(enemy);
    fleet.order={systemId:home.id,position:{x:500,y:500},targetFleetId:null,route:[]};
    for(let i=0;i<2;i++){
      militaryRules(s,a,m);
      expect(m.tasks.find(t=>t.expert==='defense')!.assets).toContain(fleet.id);
      expect(m.tasks.find(t=>t.expert==='campaign')!.assets).not.toContain(fleet.id);
    }
  });
  it('releases surplus garrisons instead of locking every local fleet into defense',()=>{
    const {s,a,home,fleet,m}=campaignFixture();home.base={hull:0};
    const enemy=structuredClone(fleet);enemy.id='invader';enemy.ownerId='umbra';s.fleets.push(enemy);
    const spare=structuredClone(fleet);spare.id='z-spare';s.fleets.push(spare);
    militaryRules(s,a,m);
    const defense=m.tasks.find(t=>t.expert==='defense'&&t.target===home.id)!;
    expect(defense.assets).toHaveLength(1);expect(defense.assets).not.toContain(spare.id);
    expect(defense.blockers).toEqual([]);
  });
  it('offers a two-ship queue fill and a one-ship funding fallback',()=>{
    const s=fixture(),m=memory();
    const orders=economicRules(s,'aurora',m).flatMap(g=>g.actions).filter(x=>x.type==='queue_ships');
    expect(orders.some(x=>x.args.count===2)).toBe(true);expect(orders.some(x=>x.args.count===1)).toBe(true);
  });
  it('allows a second staffed shipyard when colony demand and paid backlog justify it',()=>{
    const s=fixture(),home=s.systems.find(x=>x.ownerId==='aurora')!;
    const yard=home.planets.find(p=>p.structures.some(b=>b.type==='shipyard'))!;
    const stage=new StagingArea(s,'aurora');
    expect(stage.execute('queue_ships',{planetId:yard.id,shipType:'destroyer',count:1}).ok).toBe(true);
    const target=stage.draft.systems.find(x=>x.id===home.id)!;
    const base=structuredClone(yard);base.structures=[];base.population=10;
    for(let i=0;i<5;i++)target.planets.push({...structuredClone(base),id:'new-colony-'+i});
    expect(economicRules(stage.draft,'aurora',memory()).some(g=>g.actions.some(x=>x.type==='build_structure'&&x.args.structureType==='shipyard'))).toBe(true);
  });
  it('never recalls an assigned invasion to rally while the target order is active',()=>{
    const {s,a,home,target,fleet,m}=campaignFixture();fleet.order={systemId:target.id,position:{x:500,y:500},targetFleetId:null,route:[target.id]};
    const rules=militaryRules(s,a,m);expect(m.tasks[0].stage).toBe('launch');expect(m.tasks[0].assets).toEqual([fleet.id]);
    expect(rules.some(g=>g.actions.some(x=>x.type==='move_fleet'&&x.args.systemId===home.id))).toBe(false);
  });
  it('freezes a sufficient assembling roster instead of waiting for every newly built fleet',()=>{
    const {s,a,fleet,m,target}=campaignFixture();
    const extra=structuredClone(fleet);extra.id='late-reinforcement';s.fleets.push(extra);
    const rules=militaryRules(s,a,m);
    expect(m.tasks[0].assets).toEqual([fleet.id]);
    expect(rules.some(g=>g.actions.some(x=>x.type==='move_fleet'&&x.args.systemId===target.id))).toBe(true);
  });
  it('records actual progress inside the rally system rather than diagnosing a false stall',()=>{
    const {s,a,home,fleet,m}=campaignFixture();
    fleet.position={x:100,y:500};fleet.order={systemId:home.id,position:{x:600,y:500},route:[],targetFleetId:null};
    refreshTasks(s,a,m);s.round=2;fleet.position.x=200;refreshTasks(s,a,m);
    expect(m.tasks[0].lastProgressRound).toBe(2);expect(m.tasks[0].diagnosedRound).toBeUndefined();
  });
  it('accepts functional staffing recovery for a blocked wartime shipyard',async()=>{
    const {s,a,home}=campaignFixture();const p=home.planets.find(p=>p.ownerId===a)!;
    p.population=3;p.structures=[{id:'yard',type:'shipyard'},{id:'mine',type:'mine'},{id:'social',type:'sanatorium'}];p.priorities={};delete p.operation;
    expect(support(p,'shipyard',s.day)).toBe(0);
    const d=await srasDecision(scriptKnowledge(s,a),a,undefined);
    const checked=validateScriptPlan(s,a,d.actions);
    const actual=checked.stage.draft.systems.flatMap(h=>h.planets).find(x=>x.id===p.id)!;
    expect(support({...actual,operation:undefined},'shipyard',s.day)).toBe(1);
  });
  it('scales all stage boundaries and permits defense during exploration',()=>{
    expect([1,20,21,40,41,80,81,105,106,120].map(r=>srasStage(r,120))).toEqual(['exploration','exploration','industry','industry','competition','competition','realization','realization','endgame','endgame']);
    expect(srasStage(2,12)).toBe('exploration');expect(srasStage(3,12)).toBe('industry');
    const s=fixture(),home=s.systems.find(x=>x.ownerId==='aurora')!,enemy=s.fleets.find(f=>f.ownerId==='umbra')!;
    enemy.systemId=home.id;s.relations[relationKey('aurora','umbra')].status='war';
    const m=memory();militaryRules(s,'aurora',m);expect(m.tasks.some(t=>t.expert==='defense')).toBe(true);
    expect(economicRules(s,'aurora',m).some(t=>t.expert==='economy'||t.expert==='exploration')).toBe(true);
  });
  it('uses no forecasts and submits exactly its independently validated groups without mutating input',async()=>{
    const s=scriptKnowledge(fixture(),'aurora'),before=stateHash(s);
    const d=await srasDecision(s,'aurora',undefined,{forecast:async()=>{throw new Error('forbidden forecast');}});
    expect(d.actions.length).toBeGreaterThan(0);expect(d.actions.length).toBeLessThanOrEqual(48);
    expect(d.scriptReport!.sras!.previews).toBeLessThanOrEqual(128);expect(d.scriptReport!.forecasts).toBe(0);
    expect(d.scriptReport!.selected.flatMap(g=>g.actions)).toEqual(d.actions);expect(d.scriptReport!.sras!.actions).toBe(d.actions.length);
    expect(validateScriptPlan(s,'aurora',d.actions).ok).toBe(true);expect(stateHash(s)).toBe(before);expect(d.metrics.requests).toBe(0);
  });
  it('retains independent groups after injected final failure and pauses after three failures',async()=>{
    const s=scriptKnowledge(fixture(),'aurora');let count=0;
    const d=await srasDecision(s,'aurora',undefined,{},(s,a,actions)=>{const r=validateScriptPlan(s,a,actions);return ++count===1?{...r,ok:false,index:actions.length-1,reason:'injected'}:r;});
    expect(d.scriptReport!.validations).toBe(2);expect(d.actions.length).toBeGreaterThan(0);expect(d.scriptReport!.sras!.groups.some(g=>g.status==='removed')).toBe(true);
    await expect(srasDecision(s,'aurora',undefined,{},(s,a,actions)=>({...validateScriptPlan(s,a,actions),ok:false,index:Math.max(0,actions.length-1),reason:'injected'}))).rejects.toThrow(/three times|removed every|invalid failure/);
  });
  it('keeps hidden foreign inventory out of decisions and explanations',async()=>{
    const s=fixture(),hidden=structuredClone(s);hidden.factions.umbra.resources.minerals+=units(123456);hidden.factions.umbra.unity=1;
    const a=await srasDecision(scriptKnowledge(s,'aurora'),'aurora',undefined),b=await srasDecision(scriptKnowledge(hidden,'aurora'),'aurora',undefined);
    expect(a.actions).toEqual(b.actions);expect(a.scriptMemory).toEqual(b.scriptMemory);expect(a.scriptReport).toEqual(b.scriptReport);
  });
  it('blocks welfare when normal bills fail, keeps unknown defenders unknown, and ignores irrelevant failure changes',()=>{
    const s=fixture();s.factions.aurora.resources.food=0;s.factions.aurora.welfare!.choice='utopian';
    expect(ledger(s,'aurora').risk).toBeGreaterThan(0);expect(scheduledRisk(s,'aurora').risk).toBeGreaterThan(0);
    const target=s.systems.find(x=>x.ownerId==='umbra')!;expect(knownDefense(scriptKnowledge(s,'aurora'),'aurora',target.id)).toBeNull();
    const action=[{type:'move_fleet',args:{fleetId:'fleet',systemId:target.id}}],before=failureDependency(s,'aurora',action,'passage');
    s.factions.aurora.resources.minerals+=units(9999);expect(failureDependency(s,'aurora',action,'passage')).toBe(before);
    const f=s.fleets.find(f=>f.ownerId==='aurora')!;expect(noChange(s,{type:'move_fleet',args:{fleetId:f.id,systemId:f.systemId}})).toBe(true);
  });
  it('exits stalled campaigns without unrelated fleets refreshing progress and binds world war IDs',()=>{
    const s=fixture(),m=memory(),target=s.systems.find(x=>x.ownerId==='umbra')!;
    m.tasks.push({id:'c',expert:'campaign',target:target.id,opponent:'umbra',stage:'assemble',assets:[],reserve:{},deadline:10000,evidence:'',lastProgressRound:0,next:'assemble',blockers:[],exit:''});
    refreshTasks(s,'aurora',m);s.round=2;refreshTasks(s,'aurora',m);expect(m.tasks[0].diagnosedRound).toBe(2);
    s.round=3;const clone=structuredClone(s.fleets[0]);clone.id='unrelated';s.fleets.push(clone);refreshTasks(s,'aurora',m);expect(m.tasks[0].stage).toBe('exit');
    s.wars=[{id:'actual-war',type:'limited',factions:['aurora','umbra'],attackers:['aurora'],startedDay:0,startedRound:0,reasons:{},goals:{aurora:[{type:'limited',systemId:target.id,heldDays:0}]},fatigue:{aurora:0,umbra:0},openingValue:{},lossWindow:0,lossUsed:{}}];
    const decision={actions:[],summary:'',trace:[],metrics:{requests:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,reportedModel:''},scriptMemory:{version:'sras-v1.1' as const,goal:null,tasks:[],failures:[],sras:m}};
    commitScriptMemory(s,{aurora:decision});expect(s.factions.aurora.scriptMemory!.sras!.tasks[0].warId).toBe('actual-war');
  });
  it('clears search profile for SRAS and preserves old defaults',()=>{
    const c=configureSeats({...structuredClone(DEFAULT_CONFIG),controller:'scripted' as const,scriptStrategy:'sras-v1.1' as const,scriptSearchProfile:'deep' as const});expect(c.scriptSearchProfile).toBeUndefined();expect(()=>validateControllers(c)).not.toThrow();
    expect(configureSeats({...structuredClone(DEFAULT_CONFIG),controller:'scripted'} as MatchConfig).scriptStrategy).toBe('adaptive-v4.12');
  });
  it('produces identical actions and memory in 0/2/8 planning workers and after serialization; abort leaves state untouched',async()=>{
    const s=fixture(),before=stateHash(s),results=[];
    const maximum=Math.max(0,availableParallelism()-2),workers=[0,Math.min(2,maximum),Math.min(8,maximum)];
    for(const workerCount of workers){const pool=new PlanningPool(8,{planningWorkers:workerCount,forecastWorkers:0});try{const d=await pool.decide(JSON.parse(JSON.stringify(s)),undefined,undefined,undefined,['aurora']);results.push({actions:d.aurora.actions,memory:d.aurora.scriptMemory});expect(pool.metrics.forecastWorkers).toBe(0);}finally{await pool.close();}}
    expect(results[1]).toEqual(results[0]);expect(results[2]).toEqual(results[0]);expect(stateHash(s)).toBe(before);
    const pool=new PlanningPool(4,{planningWorkers:0,forecastWorkers:0}),abort=new AbortController();abort.abort();try{await expect(pool.decide(s,abort.signal)).rejects.toThrow();}finally{await pool.close();}expect(stateHash(s)).toBe(before);
  },120000);
  it('uses actual 48/49 accounting and rolls back a failing batch without reserving resources',()=>{
    const s=fixture(),f=s.fleets.find(f=>f.ownerId==='aurora')!,stage=new StagingArea(s,'aurora');
    for(let i=0;i<48;i++)expect(stage.execute('move_fleet',{fleetId:f.id,systemId:f.systemId,x:600+i,y:500,targetFleetId:null}).ok).toBe(true);
    const hash=stateHash(stage.draft);expect(stage.execute('move_fleet',{fleetId:f.id,systemId:f.systemId,x:800,y:500,targetFleetId:null}).ok).toBe(false);expect(stateHash(stage.draft)).toBe(hash);
    const fresh=new StagingArea(s,'aurora'),before=stateHash(fresh.draft),planet=s.systems.flatMap(s=>s.planets).find(p=>p.ownerId==='aurora')!;
    expect(fresh.execute('queue_ships_many',{orders:[{planetId:planet.id,shipType:'destroyer',count:1},{planetId:'missing',shipType:'destroyer',count:1}]}).ok).toBe(false);expect(fresh.actions).toHaveLength(0);expect(stateHash(fresh.draft)).toBe(before);
  });
  it('reserves production funding instead of repeatedly spending it on cheap ships',async()=>{
    const s=scriptKnowledge(fixture(),'aurora'),home=s.systems.find(x=>x.ownerId==='aurora')!;
    const colony=home.planets.find(p=>p.ownerId!=='aurora')!;colony.ownerId='aurora';colony.population=4;colony.structures=[];
    s.factions.aurora.resources={energy:units(3000),food:units(3000),minerals:units(100),alloys:units(500)};
    const d=await srasDecision(s,'aurora',undefined);
    expect(d.scriptMemory!.sras!.tasks.some(t=>t.id.startsWith('development:'))).toBe(true);
    expect(d.actions.some(a=>a.type==='queue_ships')).toBe(false);
    expect(d.actions.some(a=>a.type==='colonize_planet')).toBe(false);
    const funded=structuredClone(s);funded.factions.aurora.resources.minerals=units(600);
    const next=await srasDecision(funded,'aurora',d.scriptMemory);
    expect(next.actions.some(a=>a.type==='build_structure'&&a.args.planetId===colony.id&&['mine','farm','solar'].includes(String(a.args.structureType)))).toBe(true);
  });
  it('checks production against colony scale rather than a fixed national mineral threshold',()=>{
    const s=fixture(),home=s.systems.find(x=>x.ownerId==='aurora')!;
    const base=home.planets[0];home.planets=Array.from({length:8},(_,i)=>({...structuredClone(base),id:'colony-'+i,population:4,structures:[]}));
    const rules=economicRules(s,'aurora',memory());
    for(const p of home.planets)expect(rules.some(g=>g.actions.some(a=>a.type==='build_structure'&&a.args.structureType==='mine'&&a.args.planetId===p.id))).toBe(true);
    expect(rules.some(g=>g.actions.some(a=>a.type==='colonize_planet'))).toBe(false);
  });
  it('launches a merged superior fleet, requires fresh intelligence, and settles controlled objectives',()=>{
    const s=fixture(),a='aurora',enemy='umbra',home=s.systems.find(x=>x.ownerId===a)!,target=s.systems.find(x=>x.ownerId===enemy)!;
    home.neighbors.push(target.id);target.neighbors.push(home.id);home.gates[target.id]={x:600,y:500};target.gates[home.id]={x:400,y:500};
    s.relations[relationKey(a,enemy)].status='war';s.relations[relationKey(a,enemy)].confirmed=[a,enemy];
    s.factions[a].resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:units(10000)};
    s.fleets=s.fleets.filter(f=>f.ownerId!==enemy);const fleet=s.fleets.find(f=>f.ownerId===a)!;fleet.ships=[{id:'strong',type:'dreadnought',hull:1000}];fleet.systemId=home.id;fleet.order=null;fleet.transit=null;
    target.base={hull:20};s.factions[a].militaryIntel={[target.id]:{day:s.day,source:'lrs',ownerId:enemy,base:{hull:20},fleets:[]}};
    s.wars=[{id:'known-war',type:'limited',factions:[a,enemy],attackers:[a],startedDay:0,startedRound:0,reasons:{},goals:{[a]:[{type:'limited',systemId:target.id,heldDays:0}]},fatigue:{[a]:0,[enemy]:0},openingValue:{},lossWindow:0,lossUsed:{}}];
    const rules=militaryRules(s,a,memory());expect(rules.some(g=>g.actions.some(x=>x.type==='move_fleet'&&x.args.systemId===target.id))).toBe(true);
    s.day=201;expect(militaryRules(s,a,memory()).some(g=>g.expert==='campaign'&&g.actions.some(x=>x.type==='move_fleet'))).toBe(false);
    target.controllerId=a;s.wars[0].goals[a][0].heldDays=200;expect(militaryRules(s,a,memory()).some(g=>g.actions.some(x=>x.type==='enforce_peace'))).toBe(true);
  });
});
