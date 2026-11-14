import { availableParallelism } from 'node:os';
import { describe, it, expect } from 'vitest';
import { createGame } from '../src/sim/world.js';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { adaptiveV41Decision, hardAllowedV41 } from '../src/sim/adaptive-v41.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { candidateFacts } from '../src/sim/adaptive-candidates.js';
import { militaryPlansV41, campaignProgressV41 } from '../src/sim/adaptive-v41-military.js';
import { validateScriptPlan, commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { emptyMetrics } from '../src/sim/bot.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { stateHash } from '../src/sim/math.js';
import { relationKey } from '../src/shared/diplomacy.js';
import type { ScriptMemory } from '../src/shared/adaptive.js';
import type { CertificateV41, CampaignV41 } from '../src/shared/adaptive-v41.js';
import { emptyRiskV4 } from '../src/sim/adaptive-v4-economy.js';
const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4.1',scriptSearchProfile:'standard',maxRounds:120},'v41-fixture');

describe('V4.1 certified whole-turn planning',()=>{
  it('certifies the exact final plan and preserves each accepted independent action',async()=>{
    const state=fixture(),known=scriptKnowledge(state,'umbra'),before=stateHash(known);
    const decision=await adaptiveV41Decision(known,'umbra',undefined);
    expect(stateHash(known)).toBe(before);
    expect(decision.actions.some(a=>a.type==='colonize_planet')).toBe(true);
    expect(decision.actions.some(a=>a.type==='survey_system')).toBe(true);
    expect(validateScriptPlan(known,'umbra',decision.actions).ok).toBe(true);
    const r=decision.scriptReport!,audit=r.v41!,final=audit.certificates.find(c=>c.id===audit.finalCertificate&&c.status==='final')!;
    expect(final).toBeDefined();expect(final.groups).toEqual(audit.submittedGroups);
    expect(r.turn!.actions).toBe(decision.actions.length);
    expect(r.selected.flatMap(g=>g.actions)).toEqual(decision.actions);
    expect(audit.selectedGroups.reduce((n,g)=>n+g.actions,0)).toBe(decision.actions.length);
    expect(r.forecasts).toBeLessThanOrEqual(48);expect(r.search!.evaluations).toBeLessThanOrEqual(256);
  },120000);
  it('does not turn existing long-term unpaid welfare into a blanket veto',()=>{
    const row=(days:number,unpaidSeverity:number)=>({...emptyRiskV4(),days,unity:60,quality:.6,unpaidSeverity});
    const first={windows:[row(100,0),row(300,0),row(1440,160)]} as CertificateV41;
    const next={windows:[row(100,0),row(300,0),row(1440,161)]} as CertificateV41;
    expect(hardAllowedV41(first,next)).toBe(true);
    expect(hardAllowedV41(first,next,true)).toBe(false);
    next.windows[1].unpaidSeverity=1;expect(hardAllowedV41(first,next)).toBe(false);
  });
  it('removes a failed group while keeping independent certified orders',async()=>{
    const s=scriptKnowledge(fixture(),'umbra'),before=stateHash(s);let calls=0;
    const result=await adaptiveV41Decision(s,'umbra',undefined,{validate:(state,actor,actions)=>{
      const checked=validateScriptPlan(state,actor,actions);calls++;
      return calls===1?{...checked,ok:false,index:actions.length-1,reason:'Injected group failure'}:checked;
    }});
    expect(result.scriptReport!.v41!.removed.length).toBeGreaterThan(0);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.scriptReport!.validations).toBe(2);
    expect(result.scriptReport!.selected.flatMap(c=>c.actions)).toEqual(result.actions);
    expect(stateHash(s)).toBe(before);
  },120000);
  it('only pursues declared objectives during a limited war',()=>{
    const s=fixture(),actor='umbra',enemy='aurora',target=s.systems.find(x=>x.ownerId===enemy)!;
    s.relations[relationKey(actor,enemy)].status='war';s.relations[relationKey(actor,enemy)].confirmed=[actor,enemy];
    s.factions[actor].surveyed.push(...s.systems.map(x=>x.id));
    for(const system of s.systems)s.factions[actor].intel[system.id]={day:0,system:structuredClone(system),fleets:[]};
    s.wars=[{id:'declared',type:'claim',factions:[actor,enemy],attackers:[actor],startedDay:0,startedRound:0,reasons:{},goals:{[actor]:[{type:'claim',systemId:target.id,heldDays:0}]},fatigue:{[actor]:0,[enemy]:0},openingValue:{},lossWindow:0,lossUsed:{}}];
    const known=scriptKnowledge(s,actor),facts=candidateFacts(known,actor,true,256,true);
    const plans=militaryPlansV41(known,actor,facts,{version:'adaptive-v4.1',goal:null,tasks:[],failures:[]});
    expect(plans.some(p=>p.mode!=='defend'&&p.opponent===enemy)).toBe(true);
    expect(plans.filter(p=>p.mode!=='defend'&&p.opponent===enemy).every(p=>p.target===target.id)).toBe(true);
  });
  it('binds predicted war IDs to actual own war settlement without changing legacy memories',()=>{
    const s=fixture(),actor='umbra',enemy='aurora',target=s.systems.find(x=>x.ownerId===enemy)!,fleet=s.fleets.find(f=>f.ownerId===actor)!;
    s.round=3;s.day=300;
    const operation:CampaignV41={id:'campaign',opponent:enemy,targets:[target.id],warType:'claim',stage:'attack',fleetIds:[fleet.id],staging:fleet.systemId,createdDay:100,deadline:3000,progress:'',lastProgressRound:2,value:100,reserve:{},blockers:[],nextStep:'attack',launchDay:200,ready:true,warId:'predicted-0'};
    s.wars=[{id:'actual-1',type:'claim',factions:[actor,enemy],attackers:[actor],startedDay:200,startedRound:2,reasons:{},goals:{[actor]:[{type:'claim',systemId:target.id,heldDays:0}]},fatigue:{[actor]:0,[enemy]:0},openingValue:{},lossWindow:0,lossUsed:{}}];
    const memory:ScriptMemory={version:'adaptive-v4.1',goal:null,failures:[],operation,tasks:[{fleetId:fleet.id,role:'attack',target:target.id,campaignId:'campaign',warId:'predicted-0'}]};
    const decision={actions:[],trace:[],summary:'',metrics:emptyMetrics(),scriptMemory:memory};
    commitScriptMemory(s,{[actor]:decision});
    const actual=s.factions[actor].scriptMemory!;
    expect((actual.operation as CampaignV41).warId).toBe('actual-1');expect(actual.tasks[0].warId).toBe('actual-1');
    expect(operation.warId).toBe('predicted-0');
    campaignProgressV41(s,actor,actual);expect(actual.operation?.stage).not.toBe('exit');expect(actual.operation?.completed).not.toBe(true);
    decision.scriptMemory={...memory,version:'adaptive-v4'};commitScriptMemory(s,{[actor]:decision});
    expect((s.factions[actor].scriptMemory!.operation as CampaignV41).warId).toBe('predicted-0');
  });
  it('does not count unrelated construction or oscillation as campaign progress',()=>{
    const s=fixture(),fleet=s.fleets.find(f=>f.ownerId==='umbra')!,target=s.systems.find(x=>x.ownerId==='aurora')!;
    const operation:CampaignV41={id:'op',opponent:'aurora',targets:[target.id],warType:'total',stage:'assemble',fleetIds:[fleet.id],staging:fleet.systemId,createdDay:0,deadline:2000,progress:'',lastProgressRound:0,value:100,reserve:{},blockers:[],nextStep:'assemble',launchDay:null,ready:false};
    const memory:ScriptMemory={version:'adaptive-v4.1',goal:null,tasks:[],failures:[],operation};
    campaignProgressV41(s,'umbra',memory);
    s.fleets.push({...structuredClone(fleet),id:'unrelated'});s.round=2;
    campaignProgressV41(s,'umbra',memory);expect(operation.stage).toBe('exit');
  });
  it('keeps 48 actions and rejects the 49th without changing the accepted draft',()=>{
    const s=fixture(),fleet=s.fleets.find(f=>f.ownerId==='umbra')!;
    const actions=Array.from({length:48},(_,i)=>({type:'move_fleet',args:{fleetId:fleet.id,systemId:fleet.systemId,x:600+i,y:500,targetFleetId:null}}));
    expect(validateScriptPlan(s,'umbra',actions).ok).toBe(true);
    expect(validateScriptPlan(s,'umbra',[...actions,actions[0]]).ok).toBe(false);
  });
  it('preserves hidden information, pause and worker determinism',async()=>{
    const s=fixture();s.config.maxRounds=2;
    const pools=[0,2,8].map(n=>Math.min(n,Math.max(0,availableParallelism()-2))).map(computeWorkers=>new PlanningPool(1,{v3:true,computeWorkers,planningCacheMiB:0}));
    try {
      const results=[];
      for(const pool of pools)results.push((await pool.decide(s,undefined,undefined,undefined,['umbra'])).umbra);
      expect(results[1].actions).toEqual(results[0].actions);expect(results[2].actions).toEqual(results[0].actions);
      expect(results[2].scriptMemory).toEqual(results[0].scriptMemory);
      s.factions.aurora.resources.minerals=units(99999);
      const hidden=(await pools[0].decide(JSON.parse(JSON.stringify(s)),undefined,undefined,undefined,['umbra'])).umbra;
      expect(hidden.actions).toEqual(results[0].actions);expect(hidden.scriptReport?.v41).toEqual(results[0].scriptReport?.v41);
      const signal=new AbortController();signal.abort();await expect(pools[0].decide(s,signal.signal,undefined,undefined,['umbra'])).rejects.toThrow('暂停');
    } finally {await Promise.all(pools.map(p=>p.close()));}
  },120000);
});
