import { availableParallelism } from 'node:os';
import {describe,it,expect} from 'vitest';
import {createGame} from '../src/sim/world.js';
import {DEFAULT_CONFIG,units} from '../src/shared/rules.js';
import {adaptiveV412Decision,hardAllowedV412} from '../src/sim/adaptive-v412.js';
import {scriptKnowledge} from '../src/sim/adaptive-knowledge.js';
import {economicForecast} from '../src/sim/forecast.js';
import {economyCandidatesV412} from '../src/sim/adaptive-v412-economy.js';
import {candidateFacts} from '../src/sim/adaptive-candidates.js';
import {militaryPlansV412,campaignProgressV412,supportActionsV412,tacticalV412,militaryActionV412,cleanTasksV412,routeSafeV412} from '../src/sim/adaptive-v412-military.js';
import {validateScriptPlan,commitScriptMemory} from '../src/sim/adaptive-adapter.js';
import {PlanningPool} from '../src/sim/planning-pool.js';
import {SimulationPool} from '../src/sim/pool.js';
import {advanceRound} from '../src/sim/engine.js';
import {stateHash} from '../src/sim/math.js';
import {relationKey} from '../src/shared/diplomacy.js';
import type {CampaignV412,MilitaryOptionV412,CertificateV412} from '../src/shared/adaptive-v412.js';
import type {ScriptMemory} from '../src/shared/adaptive.js';
import {emptyRiskV4} from '../src/sim/adaptive-v4-economy.js';
import {capacityV412,conditionalValueV412,militaryDependencyV412,commitmentBlockV412} from '../src/sim/adaptive-v412-capacity.js';

const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4.12',scriptSearchProfile:'standard',maxRounds:120},'v412-fixture');
const memory=():ScriptMemory=>({version:'adaptive-v4.12',goal:null,tasks:[],failures:[]});
function warFixture(){
  const s=fixture(),actor='umbra',enemy='aurora',target=s.systems.find(x=>x.ownerId===enemy)!,fleet=s.fleets.find(f=>f.ownerId===actor)!;
  s.relations[relationKey(actor,enemy)].status='war';s.relations[relationKey(actor,enemy)].confirmed=[actor,enemy];
  s.factions[actor].surveyed=s.systems.map(x=>x.id);
  for(const system of s.systems)s.factions[actor].intel[system.id]={day:0,system:structuredClone(system),fleets:structuredClone(s.fleets.filter(f=>f.systemId===system.id))};
  s.wars=[{id:'actual-war',type:'claim',factions:[actor,enemy],attackers:[actor],startedDay:0,startedRound:0,reasons:{},goals:{[actor]:[{type:'claim',systemId:target.id,heldDays:0}]},fatigue:{[actor]:0,[enemy]:0},openingValue:{},lossWindow:0,lossUsed:{}}];
  return {s,actor,enemy,target,fleet};
}
describe('V4.12 continuous operations',()=>{
  it('keeps secular when a permanent duty has no timely evaluated outcome',()=>{
    const {s,actor}=warFixture();
    expect(commitmentBlockV412(s,actor,'militarist',[])).toBeTruthy();
    const p={evaluated:true,unknown:false,eliminated:false,ready:true,value:100,expectedDay:500,warType:'claim',fleetIds:[s.fleets.find(f=>f.ownerId===actor)!.id],scenarios:[{won:true}]} as unknown as MilitaryOptionV412;
    expect(commitmentBlockV412(s,actor,'militarist',[p])).toBeNull();
    expect(commitmentBlockV412(s,actor,'militarist',[{...p,expectedDay:1000}])).toBeTruthy();
    expect(commitmentBlockV412(s,actor,'militarist',[{...p,unknown:true}])).toBeTruthy();
    expect(commitmentBlockV412(s,actor,'theocracy',[p])).toBeTruthy();
  });
  it('allows safe home assembly while target intelligence is stale without authorizing an attack',()=>{
    const {s,actor,enemy,target,fleet}=warFixture();
    const known=scriptKnowledge(s,actor),home=s.systems.find(x=>x.ownerId===actor)!;
    fleet.position={x:100,y:100};known.fleets.find(f=>f.id===fleet.id)!.position={x:100,y:100};
    const p={id:'stale-gather',opponent:enemy,target:target.id,warType:'claim',mode:'concentrated',fleetIds:[fleet.id],staging:home.id,arrival:100,expectedDay:300,knownPower:40,availablePower:100,unknown:true,intelDays:[0],scenarios:[],territory:0,duty:0,maintenance:0,value:100,blockers:[],ready:false,preparation:false} as MilitaryOptionV412;
    const c=militaryActionV412(known,actor,p,candidateFacts(known,actor,true,Infinity,true));
    expect(c?.kind).toBe('assemble');expect(c!.actions.every(a=>a.type!=='declare_war'&&a.args.systemId===home.id)).toBe(true);
  });
  it('rekeys resource, queue and order changes, and does not collect one campaign reward twice',()=>{
    const s=scriptKnowledge(fixture(),'umbra'),key=militaryDependencyV412(s,'umbra');
    const child=structuredClone(s);child.factions.umbra.resources.minerals-=1000;
    expect(militaryDependencyV412(child,'umbra')).not.toBe(key);
    expect(militaryDependencyV412(s,'umbra')).toBe(key);
    const military={planKey:'one-outcome',mode:'concentrated',opponent:'aurora',target:'s0',warType:'claim'} as MilitaryOptionV412;
    expect(conditionalValueV412([{kind:'assemble',target:'s0',value:30,military},{kind:'war',target:'s0',value:50,military}])).toBe(50);
  });
  it('allocates each fleet once across competing border needs and persists paid completion dates',()=>{
    const {s,actor,enemy,fleet}=warFixture(),home=s.systems.find(x=>x.ownerId===actor)!;
    const hostile=s.fleets.find(f=>f.ownerId===enemy)!;hostile.systemId=home.id;hostile.position={x:500,y:500};
    s.factions[actor].intel[home.id]={day:0,system:structuredClone(home),fleets:[hostile]};
    const known=scriptKnowledge(s,actor),ledger=capacityV412(known,actor,[],{alternatives:[]});
    expect(ledger.needs.length).toBeGreaterThan(0);
    expect(new Set(ledger.allocations.map(a=>a.fleetId)).size).toBe(ledger.allocations.length);
    expect(ledger.needs.every(n=>n.missing>=0)).toBe(true);
    expect(ledger.allocations.filter(a=>a.fleetId===fleet.id).length).toBeLessThanOrEqual(1);
  });
  it('evaluates defensive response against the same enemy attack with original own orders',()=>{
    const {s,actor,enemy,fleet}=warFixture(),home=s.systems.find(x=>x.ownerId===actor)!;
    home.base=null;fleet.systemId=home.id;fleet.position={x:500,y:500};
    fleet.ships=Array.from({length:6},(_,i)=>({id:'defender-'+i,type:'battleship',hull:80}));
    const hostile=s.fleets.find(f=>f.ownerId===enemy)!;hostile.systemId=home.id;hostile.position={x:600,y:500};
    hostile.ships=[{id:'attacker',type:'destroyer',hull:10}];
    s.factions[actor].intel[home.id]={day:0,system:structuredClone(home),fleets:[structuredClone(hostile)]};
    for(const [id,intel] of Object.entries(s.factions[actor].intel))if(id!==home.id)intel.fleets=intel.fleets.filter(f=>f.id!==hostile.id);
    const known=scriptKnowledge(s,actor),before=stateHash(known);
    const option={id:'response',opponent:enemy,target:home.id,warType:'claim',mode:'defend',fleetIds:[fleet.id],threatFleetIds:[hostile.id],staging:home.id,arrival:0,expectedDay:0,knownPower:10,availablePower:480,unknown:false,intelDays:[0],scenarios:[],territory:0,duty:0,maintenance:0,value:0,blockers:[],ready:true,preparation:false} as MilitaryOptionV412;
    const active=tacticalV412(known,{actor,option}),wait=tacticalV412(known,{actor,option:{...option,response:'wait'}});
    // Already defended in place: moving again must not claim credit for all assets saved.
    expect(active.value-wait.value).toBeCloseTo(0,5);expect(stateHash(known)).toBe(before);
  });
  it('assigns each fresh hostile fleet to one home threat and retains an unfilled defense requirement',()=>{
    const {s,actor,enemy}=warFixture();
    const home=s.systems.find(x=>x.ownerId===actor)!;
    const enemyFleet=s.fleets.find(f=>f.ownerId===enemy)!;
    enemyFleet.systemId=home.id;enemyFleet.position={x:500,y:500};
    enemyFleet.ships=[{id:'invasion',type:'dreadnought',hull:200}];
    s.fleets=s.fleets.filter(f=>f.ownerId!==actor);
    s.factions[actor].intel[home.id]={day:0,system:structuredClone(home),fleets:[structuredClone(enemyFleet)]};
    for(const [id,intel] of Object.entries(s.factions[actor].intel))if(id!==home.id)intel.fleets=intel.fleets.filter(f=>f.id!==enemyFleet.id);
    const known=scriptKnowledge(s,actor),plans=militaryPlansV412(known,actor,candidateFacts(known,actor,true,Infinity,true),memory());
    const assigned=plans.filter(p=>p.mode==='defend'&&p.threatFleetIds?.includes(enemyFleet.id));
    expect(assigned).toHaveLength(1);expect(assigned[0].target).toBe(home.id);
    expect(assigned[0].fleetIds).toHaveLength(0);expect(assigned[0].shortPower).toBeGreaterThan(0);
  });
  it('does not credit an unrelated completed claim to home defense',()=>{
    const {s,actor,enemy,target}=warFixture(),home=s.systems.find(x=>x.ownerId===actor)!;
    target.controllerId=actor;s.wars![0].goals[actor][0].heldDays=200;
    s.fleets=s.fleets.filter(f=>f.ownerId!==enemy);
    for(const intel of Object.values(s.factions[actor].intel))intel.fleets=intel.fleets.filter(f=>f.ownerId!==enemy);
    const option={id:'home-wait',opponent:enemy,target:home.id,warType:'claim',mode:'defend',fleetIds:[],staging:home.id,arrival:0,expectedDay:0,knownPower:0,availablePower:0,unknown:false,intelDays:[],scenarios:[],territory:0,duty:0,maintenance:0,value:0,blockers:[],ready:true,preparation:false} as MilitaryOptionV412;
    const evaluated=tacticalV412(scriptKnowledge(s,actor),{actor,option});
    expect(evaluated.scenarios.every(row=>Math.abs(row.value)<0.001)).toBe(true);
  });
  it('keeps funding and occupied delivery separate, retaining military repair options',()=>{
    const {s,actor,enemy}=warFixture();
    s.factions[actor].resources={energy:units(20000),food:units(20000),minerals:units(20000),alloys:units(20000)};
    const owned=s.systems.filter(x=>x.ownerId===actor);owned[0].controllerId=enemy;
    const known=scriptKnowledge(s,actor),forecast=economicForecast(known,actor,[100,300],{version:'v4.12',actionable:true});
    expect(forecast.trajectory!.at(-1)!.causes!.blockedSeverity).toBeGreaterThan(0);
    expect(forecast.trajectory!.at(-1)!.causes!.fundingSeverity).toBe(0);
    const facts=candidateFacts(known,actor,true,Infinity,true);
    const ships=facts.candidates.filter(c=>c.kind==='ships');
    // Give a known intact colony a legal yard if the starting map has only one.
    if(!ships.length){const intact=owned.find(x=>x!==owned[0])??owned[0];intact.controllerId=actor;const p=intact.planets.find(p=>p.ownerId===actor)!;p.structures.push({id:'extra-yard',type:'shipyard'});}
    const k=scriptKnowledge(s,actor),f=candidateFacts(k,actor,true,Infinity,true);
    expect(economyCandidatesV412(k,actor,f.candidates,forecast).some(c=>c.kind==='ships')).toBe(true);
  });
  it('allows a funded recovery without treating blocked welfare as insolvency',()=>{
    const row=(fundingSeverity:number,blockedSeverity:number)=>({...emptyRiskV4(),days:300,unity:50,quality:.5,unpaidSeverity:fundingSeverity+blockedSeverity,causes:{fundingDays:0,fundingSeverity,blockedDays:100,blockedSeverity,supplyRecoveryDay:300,fundingRecoveryDay:300,dissatisfaction:100,overdueDays:500,faithCrisis:0,quality:.5,resources:{}}});
    const a={windows:[row(0,50)]} as CertificateV412,b={windows:[row(0,60)]} as CertificateV412;
    expect(hardAllowedV412(a,b)).toBe(true);b.windows[0].causes!.fundingSeverity=10;
    expect(hardAllowedV412(a,b,true)).toBe(false);
  });
  it('keeps occupied objectives and settles actual continuous control',()=>{
    const {s,actor,enemy,target,fleet}=warFixture();target.controllerId=actor;fleet.systemId=target.id;fleet.position={x:500,y:500};
    s.fleets=s.fleets.filter(f=>f.ownerId!==enemy);s.wars![0].goals[actor][0].heldDays=200;
    const known=scriptKnowledge(s,actor),facts=candidateFacts(known,actor,true,Infinity,true);
    const plans=militaryPlansV412(known,actor,facts,memory()).filter(p=>p.target===target.id&&p.holding);
    expect(plans.length).toBeGreaterThan(0);
    const candidate=militaryActionV412(known,actor,{...plans[0],value:100},facts)!;
    expect(candidate.actions.some(a=>a.type==='enforce_peace')).toBe(true);
  });
  it('locks primary ships and reassesses stalled campaigns without deleting them',()=>{
    const {s,actor,enemy,target,fleet}=warFixture(),m=memory();
    const op:CampaignV412={id:'stable',opponent:enemy,targets:[target.id],warType:'claim',stage:'assemble',fleetIds:[fleet.id],shipIds:fleet.ships.map(x=>x.id),staging:fleet.systemId,createdDay:0,deadline:3000,progress:'',lastProgressRound:0,value:100,reserve:{},blockers:[],nextStep:'assemble',launchDay:null,ready:false};m.operation=op;
    campaignProgressV412(s,actor,m);s.round=2;
    s.fleets.push({...structuredClone(fleet),id:'new-unrelated',ships:fleet.ships.map(ship=>({...ship,id:ship.id+'-new'}))});
    campaignProgressV412(s,actor,m);expect(op.reassess).toBe(true);expect(op.stage).not.toBe('exit');
    const k=scriptKnowledge(s,actor),plans=militaryPlansV412(k,actor,candidateFacts(k,actor,true,Infinity,true),m).filter(p=>p.target===target.id);
    expect(plans.length).toBeGreaterThan(0);expect(plans.every(p=>!p.fleetIds.includes('new-unrelated'))).toBe(true);
    expect(plans.some(p=>p.waves?.some(w=>w.role==='support'&&w.fleetIds.includes('new-unrelated')))).toBe(true);
    s.wars![0].goals[actor][0].heldDays=0;op.milestones!.held=150;campaignProgressV412(s,actor,m);expect(op.milestones!.held).toBe(0);
  });
  it('does not send a lone support ship into known superior reinforcement',()=>{
    const {s,actor,enemy,target,fleet}=warFixture(),home=s.systems.find(x=>x.ownerId===actor)!;
    const defender=s.fleets.find(f=>f.ownerId===enemy)!;defender.systemId=target.id;defender.ships=Array.from({length:20},(_,i)=>({id:'enemy-'+i,type:'battleship',hull:80}));
    s.factions[actor].intel[target.id].fleets=[defender];
    fleet.systemId=home.id;fleet.position={x:500,y:500};
    const option={opponent:enemy,target:target.id,staging:home.id,waves:[{role:'support',fleetIds:[fleet.id],shipIds:fleet.ships.map(s=>s.id),target:target.id,staging:home.id,departureDay:0,arrivalDay:100,projects:[]}]} as unknown as MilitaryOptionV412;
    expect(supportActionsV412(s,actor,option).some(a=>a.type==='move_fleet'&&a.args.systemId===target.id)).toBe(false);
  });
  it('compares support arrival without allowing unpaid or late ships into the first battle',()=>{
    const {s,actor,enemy,target,fleet}=warFixture();
    const enemyFleet=s.fleets.find(f=>f.ownerId===enemy)!;
    enemyFleet.systemId=target.id;enemyFleet.position={x:500,y:500};enemyFleet.ships=[{id:'enemy-heavy',type:'dreadnought',hull:200}];
    fleet.systemId=target.id;fleet.position={x:500,y:500};fleet.ships=[{id:'weak-primary',type:'destroyer',hull:10}];
    s.factions[actor].intel[target.id].fleets=[enemyFleet];
    const known=scriptKnowledge(s,actor),facts=candidateFacts(known,actor,true,Infinity,true),p=militaryPlansV412(known,actor,facts,memory()).find(p=>p.target===target.id)!;
    expect(p).toBeDefined();
    p.waves!.push({role:'support',fleetIds:[],shipIds:[],staging:target.id,target:target.id,departureDay:500,arrivalDay:500,projects:[{id:'late-paid',systemId:target.id,shipType:'dreadnought',completeDay:500,arrivalDay:500}]});
    const evaluated=tacticalV412(known,{actor,option:p});
    expect(evaluated.scenarios.every(r=>r.ownLoss>=5)).toBe(true);
    expect(evaluated.availablePower).toBe(p.availablePower);
    expect(evaluated.scenarioEvidence?.length).toBeGreaterThan(0);
  });
  it('pauses after three full validation failures without changing the boundary',async()=>{
    const s=scriptKnowledge(fixture(),'umbra'),before=stateHash(s);let calls=0;
    await expect(adaptiveV412Decision(s,'umbra',undefined,{validate:(world,actor,actions)=>{calls++;return {...validateScriptPlan(world,actor,actions),ok:false,index:actions.length-1,reason:'Injected persistent conflict'};}})).rejects.toThrow('暂停');
    expect(calls).toBeLessThanOrEqual(3);expect(calls).toBeGreaterThan(1);expect(stateHash(s)).toBe(before);
  },120000);
  it('retains merged support identity and treats occupied legal territory as survival',()=>{
    const {s,actor,enemy,target,fleet}=warFixture(),m=memory();
    const support={...structuredClone(fleet),id:'support-new-id'};s.fleets=s.fleets.filter(f=>f.id!==fleet.id);s.fleets.push(support);
    m.operation={id:'stable-operation',opponent:enemy,targets:[target.id],warType:'claim',stage:'assemble',fleetIds:[],shipIds:[],staging:support.systemId,createdDay:0,deadline:1000,progress:'',lastProgressRound:0,value:100,reserve:{},blockers:[],nextStep:'support',launchDay:null,ready:false,waves:[{role:'support',fleetIds:['old-merged-id'],shipIds:support.ships.map(s=>s.id),staging:support.systemId!,target:target.id,departureDay:0,arrivalDay:200,projects:[]}]} as CampaignV412;
    cleanTasksV412(s,actor,m);expect(m.tasks.some(t=>t.fleetId===support.id&&t.campaignId==='stable-operation')).toBe(true);
    for(const sys of s.systems.filter(s=>s.ownerId===actor))sys.controllerId=enemy;
    const option={id:'occupied-survival',opponent:enemy,target:target.id,warType:'claim',mode:'defend',fleetIds:[support.id],staging:target.id,arrival:0,expectedDay:0,knownPower:0,availablePower:20,unknown:false,intelDays:[],scenarios:[],territory:0,duty:0,maintenance:0,value:0,blockers:[],ready:true,preparation:false} as MilitaryOptionV412;
    expect(tacticalV412(scriptKnowledge(s,actor),{actor,option}).eliminated).toBe(false);
  });
  it('turns a favorable concentrated total-war plan into legal coordinated orders',()=>{
    const {s,actor,enemy,target,fleet}=warFixture();
    s.wars![0].type='total';s.wars![0].goals={[actor]:[],[enemy]:[]};
    fleet.ships=Array.from({length:8},(_,i)=>({id:'main-'+i,type:'battleship',hull:80}));
    s.fleets=s.fleets.filter(f=>f.ownerId!==enemy);
    for(const intel of Object.values(s.factions[actor].intel))intel.fleets=intel.fleets.filter(f=>f.ownerId!==enemy);
    const known=scriptKnowledge(s,actor),facts=candidateFacts(known,actor,true,Infinity,true);
    const option=militaryPlansV412(known,actor,facts,memory()).find(p=>p.target===target.id&&p.variant==='concentrated')!;
    expect(option).toBeDefined();
    const result=tacticalV412(known,{actor,option});
    expect(result.value).toBeGreaterThan(0);expect(result.scenarios.every(s=>s.won)).toBe(true);
    const candidate=militaryActionV412(known,actor,result,facts)!;
    expect(candidate.actions.some(a=>a.type==='move_fleet'&&a.args.systemId===target.id)).toBe(true);
    expect(validateScriptPlan(known,actor,candidate.actions).ok).toBe(true);
  });
  it('submits exact certificates, preserves useful independent groups and enforces 48/49',async()=>{
    const s=scriptKnowledge(fixture(),'umbra'),before=stateHash(s);let validations=0;
    const d=await adaptiveV412Decision(s,'umbra',undefined,{validate:(state,actor,actions)=>{const result=validateScriptPlan(state,actor,actions);validations++;return validations===1?{...result,ok:false,index:actions.length-1,reason:'Injected isolated group failure'}:result;}});
    expect(d.actions.length).toBeGreaterThan(0);expect(d.scriptReport!.validations).toBe(2);
    expect(d.scriptReport!.selected.flatMap(g=>g.actions)).toEqual(d.actions);expect(d.scriptReport!.turn!.actions).toBe(d.actions.length);
    expect(d.scriptReport!.forecasts).toBeLessThanOrEqual(48);expect(d.scriptReport!.search!.evaluations).toBeLessThanOrEqual(256);expect(stateHash(s)).toBe(before);
    const fleet=s.fleets.find(f=>f.ownerId==='umbra')!;
    const actions=Array.from({length:48},(_,i)=>({type:'move_fleet',args:{fleetId:fleet.id,systemId:fleet.systemId,x:600+i,y:500,targetFleetId:null}}));
    expect(validateScriptPlan(s,'umbra',actions).ok).toBe(true);expect(validateScriptPlan(s,'umbra',[...actions,actions[0]]).ok).toBe(false);
  },120000);
  it('keeps parallel execution, serialized memory and hidden changes deterministic',async()=>{
    const s=fixture();s.config.maxRounds=2;const outputs=[];
    const simulation=new SimulationPool(0);
    try {for(const workers of [0,2,8].map(n=>Math.min(n,Math.max(0,availableParallelism()-2)))){const pool=new PlanningPool(1,{v3:true,computeWorkers:workers,planningCacheMiB:0});try{
      const decisions=await pool.decide(s,undefined,undefined,undefined,['umbra']);const d=decisions.umbra;
      const next=await advanceRound(s,simulation,{umbra:d.actions});commitScriptMemory(next,decisions);
      outputs.push({actions:d.actions,memory:d.scriptMemory,hash:stateHash(next)});
      if(workers===0){const hidden=structuredClone(s);hidden.factions.aurora.resources.minerals+=units(100000);const other=(await pool.decide(hidden,undefined,undefined,undefined,['umbra'])).umbra;expect(other.actions).toEqual(d.actions);expect(other.scriptReport!.v412).toEqual(d.scriptReport!.v412);}
      expect(JSON.parse(JSON.stringify(d.scriptMemory))).toEqual(d.scriptMemory);
      const signal=new AbortController();signal.abort();await expect(pool.decide(s,signal.signal)).rejects.toThrow('暂停');
    }finally{await pool.close();}}expect(outputs[1]).toEqual(outputs[0]);expect(outputs[2]).toEqual(outputs[0]);}finally{await simulation.close();}
  },120000);
});
