import { performance } from 'node:perf_hooks';
import { SRAS, srasStage, type SrasMemory } from '../shared/sras.js';
import type { ScriptMemory, ScriptReport } from '../shared/adaptive.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import { constructionView } from '../shared/construction.js';
import { allocation, LABOR } from '../shared/industry.js';
import { SHIPS, STRUCTURES } from '../shared/rules.js';
import { StagingArea } from './actions.js';
import { emptyMetrics } from './bot.js';
import type { PlanningHooks } from './adaptive-v2.js';
import { validateScriptPlan } from './adaptive-adapter.js';
import { economicRules } from './sras-economy.js';
import { militaryRules, refreshTasks } from './sras-military.js';
import {conflictKeys,candidateDependency,responseRules,situation,fallbackChecks} from './sras-response.js';
import { basics, deadlineSafe, digest, failureCategory, failureDependency, ledger, owned, remaining, safeContactPath, type RuleGroup } from './sras-rules.js';

// A piecewise linear cash ledger, not a world/economic forecast. Queue completion
// dates are frozen at currently known staffing and supply. Unknown dates get no credit.
export function scheduledRisk(s:GameState,a:string) {
  const book=ledger(s,a),end=s.day+book.days,copy=structuredClone(s),stocks=Object.fromEntries(basics.map(k=>[k,s.factions[a].resources[k]/1000]));
  const dates:{day:number;planet:string;system:string;project?:string;restart?:string}[]=[];
  for(const system of owned(s,a))for(const p of system.planets.filter(p=>p.ownerId===a)) {
    for(const q of constructionView(s,system,p).queues.flatMap(q=>q.projects))if(q.estimatedCompleteDay!==null&&q.estimatedCompleteDay<=end)dates.push({day:q.estimatedCompleteDay,planet:p.id,system:system.id,project:q.id});
    for(const b of p.structures)if(!b.sealed&&b.restartUntil&&b.restartUntil>s.day&&b.restartUntil<=end)dates.push({day:b.restartUntil,planet:p.id,system:system.id,restart:b.id});
  }
  dates.sort((x,y)=>x.day-y.day||(x.project??x.restart!).localeCompare(y.project??y.restart!));
  let day=s.day,net=book.net;const deficits={energy:0,food:0,minerals:0},shipUpkeep={energy:0,minerals:0};
  const integrate=(to:number)=>{for(const k of basics){stocks[k]+=net[k]*(to-day)/100;deficits[k]=Math.max(deficits[k],-stocks[k]);}day=to;};
  for(const row of dates) {
    integrate(row.day);
    const system=copy.systems.find(x=>x.id===row.system)!,project=system.projects.find(x=>x.id===row.project),p=system.planets.find(x=>x.id===row.planet)!;
    if(project?.kind==='building'&&project.structureType){p.structures.push({id:project.id,type:project.structureType});delete p.operation;}
    if(row.restart){delete p.structures.find(b=>b.id===row.restart)!.restartUntil;delete p.operation;}
    if(project?.kind==='ship'&&project.shipType){shipUpkeep.energy+=SHIPS[project.shipType].energy*book.economy.fleetMultiplier;shipUpkeep.minerals+=SHIPS[project.shipType].upkeep*book.economy.fleetMultiplier;}
    net=ledger(copy,a).net;net.energy-=shipUpkeep.energy;net.minerals-=shipUpkeep.minerals;
  }
  integrate(end);return {risk:Object.values(deficits).reduce((n,x)=>n+x,0),deficits};
}
export function noChange(s:GameState,action:Action) {
  const p=s.systems.flatMap(x=>x.planets).find(x=>x.id===action.args.planetId),f=s.fleets.find(x=>x.id===action.args.fleetId);
  if(action.type==='set_structure_status')return p?.structures.find(x=>x.id===action.args.structureId)?.sealed===action.args.sealed;
  if(action.type==='set_jobs')return p?.priorities?.[action.args.structureType as keyof typeof STRUCTURES]===action.args.priority;
  if(action.type==='move_fleet')return !!f&&(!!f.order&&f.order.systemId===action.args.systemId&&(action.args.x==null||f.order.position.x===action.args.x&&f.order.position.y===action.args.y)||f.systemId===action.args.systemId&&!f.order&&(action.args.x==null||f.position.x===action.args.x&&f.position.y===action.args.y));
  return false;
}
export async function srasDecision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:PlanningHooks={},validator=validateScriptPlan):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('SRAS requires rules 5.4');
  const start=performance.now(),checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  await checkpoint();await hooks.inputAudit?.(structuredClone(world));
  const m:SrasMemory=previous?.version==='sras-v1'&&previous.sras?structuredClone(previous.sras):{revision:SRAS.revision,stage:'exploration',tasks:[],failures:[]};
  m.revision=SRAS.revision;m.stage=srasStage(world.round+1,world.config.maxRounds);refreshTasks(world,actor,m);
  const initial=ledger(world,actor);
  const report:ScriptReport={version:'sras-v1',candidates:0,forecasts:0,validations:0,exhausted:false,alternatives:[],selected:[],rejected:[],assumptions:'Pure current-state rules; 300-day linear ledger; no forecasts, combat simulations, search or models.',sras:{revision:SRAS.revision,stage:m.stage,triggers:[...(initial.risk>0?['supply-deficit']:[]),...(world.wars?.some(w=>w.factions.includes(actor)&&w.endedDay===undefined)?['war']:[])],tasks:[],previews:0,actions:0,stop:'no eligible rule',normalNet:initial.normalNet,reserves:initial.reserves,deficits:initial.deficits,groups:[],blocked:[]}};
  let stage=new StagingArea(world,actor),merged=false;
  const ctx=situation(world,actor);m.situation=ctx.flags;m.switches??={};
  report.sras!.situation=ctx.flags;report.sras!.threats=ctx.threats;
  const spent={emergency:0,economy:0,campaign:0,fallback:0};report.sras!.budget=spent;
  report.sras!.counters={unique:0,duplicates:0,conflicts:0,accepted:0,rejected:0};
  const locks=new Set<string>(),rejectedKeys=new Set<string>(),unique=new Set<string>();
  let fallback=false;
  const accepted:RuleGroup[]=[],seen=new Set<string>(),chosen=new Set<string>(),militaryDone=new Set<string>();
  while(report.sras!.previews<SRAS.previews&&stage.actions.length<SRAS.actions) {
    await checkpoint();
    // Refresh defense/task allocations before the economy decides ship funding
    // and cancellations; otherwise a newly detected invasion is one prefix late.
    const proposed=structuredClone(m);
    const military=militaryRules(stage.draft,actor,proposed);
    const all=[...responseRules(stage.draft,actor,proposed),...economicRules(stage.draft,actor,proposed),...military];
    const category=(c:RuleGroup):keyof typeof spent=>fallback?'fallback':c.priority===0||c.expert==='defense'&&c.priority<2?'emergency':['campaign','opportunity','diplomacy'].includes(c.expert)?'campaign':'economy';
    const candidates=all.filter(c=>{
      if(chosen.has(c.id)||c.actions.some(a=>noChange(stage.draft,a))||merged&&['campaign','opportunity'].includes(c.expert))return false;
      if(c.actions.flatMap(conflictKeys).some(k=>locks.has(k))){report.sras!.counters!.conflicts++;return false;}
      if(c.actions.some(a=>conflictKeys(a).some(k=>m.switches?.[k]&&world.round-m.switches[k].round<SRAS.switchCooldownRounds&&m.switches[k].value!==JSON.stringify(a.args)))&&c.priority>0)return false;
      return !c.actions.some(a=>a.args.fleetId&&militaryDone.has(String(a.args.fleetId)));
    });
    const order:readonly string[]=SRAS.phaseExperts[m.stage as keyof typeof SRAS.phaseExperts];
    const phaseRank=(c:RuleGroup)=>c.priority<2?0:Math.max(0,order.indexOf(c.expert));
    candidates.sort((x,y)=>x.priority-y.priority||phaseRank(x)-phaseRank(y)||y.rank-x.rank||x.id.localeCompare(y.id));
    const book=ledger(stage.draft,actor);
    // A concrete affordable-with-saving production task outranks discretionary spending.
    // This is a cash reservation, not another payment or a forecast/search branch.
    const previousDevelopment=m.tasks.find(t=>t.id.startsWith('development:'));
    m.tasks=m.tasks.filter(t=>!t.id.startsWith('development:'));
    const production=candidates.filter(c=>c.expert==='economy'&&c.actions.length===1&&c.actions[0].type==='build_structure'&&['mine','farm','solar'].includes(String(c.actions[0].args.structureType)));
    const canSave=(c:RuleGroup)=>{const type=c.actions[0].args.structureType as keyof typeof STRUCTURES;return STRUCTURES[type].minerals+book.reserves.minerals<=stage.draft.factions[actor].resources.minerals/1000+Math.max(0,book.net.minerals)*SRAS.development.savingRounds;};
    const development=production.find(c=>'development:'+c.id===previousDevelopment?.id&&canSave(c))??production.find(canSave);
    if(development){const action=development.actions[0],type=action.args.structureType as keyof typeof STRUCTURES,system=stage.draft.systems.find(s=>s.planets.some(p=>p.id===action.args.planetId))!;
      m.tasks.push({id:'development:'+development.id,expert:'economy',target:system.id,assets:[],reserve:{minerals:STRUCTURES[type].minerals,alloys:LABOR[type].alloys},stage:'prepare',deadline:world.day+SRAS.development.savingRounds*100,evidence:'current staffing and useful production rule passed',lastProgressRound:previousDevelopment?.lastProgressRound??world.round,next:`build ${type} on ${String(action.args.planetId)}; mineral gap ${Math.max(0,STRUCTURES[type].minerals+book.reserves.minerals-stage.draft.factions[actor].resources.minerals/1000).toFixed(1)}`,blockers:[],exit:'target invalid, paid construction already queued or production target met'});
    }
    let advanced=false;
    for(const c of candidates) {
      const bucket=category(c),active=new Set(candidates.map(category));
      const spare=Object.keys(spent).filter(k=>k!=='fallback'&&!active.has(k as keyof typeof spent)).reduce((n,k)=>n+Math.max(0,SRAS.budgets[k as keyof typeof spent]-spent[k as keyof typeof spent]),0);
      if(!fallback&&(report.sras!.previews>=104||spent[bucket]>=SRAS.budgets[bucket]+spare))continue;
      const signature=candidateDependency(stage.draft,actor,c);
      if(seen.has(signature)||rejectedKeys.has(signature)||m.failures.some(f=>f.id===c.id&&f.dependency===failureDependency(stage.draft,actor,c.actions,f.category))){report.sras!.counters!.duplicates++;continue;}
      unique.add(c.id);report.sras!.counters!.unique=unique.size;spent[bucket]++;
      seen.add(signature);report.candidates++;report.sras!.previews++;
      const preview=new StagingArea(stage.draft,actor);let reason='';
      for(const action of c.actions){if(!safeContactPath(preview.draft,actor,action)){reason='unsafe or unknown contact along movement route';break;}const r=preview.execute(action.type,action.args);if(!r.ok){reason=r.error??'known validation failed';break;}}
      if(!reason&&stage.actions.length+preview.actions.length>SRAS.actions)reason='48 atomic-action limit';
      if(!reason&&!deadlineSafe(preview.draft,actor,stage.draft))reason='cannot complete by terminal date';
      if(!reason) {
        const before=scheduledRisk(stage.draft,actor),after=scheduledRisk(preview.draft,actor);
        if(after.risk>before.risk+1e-6)reason='increases 300-day linear supply deficit';
        if(c.actions.some(x=>x.type==='set_structure_status'&&x.args.sealed===false)){
          const running=structuredClone(preview.draft);
          for(const p of running.systems.flatMap(x=>x.planets))for(const b of p.structures)if(c.actions.some(x=>x.args.structureId===b.id&&x.args.sealed===false))delete b.restartUntil;
          if(scheduledRisk(running,actor).risk>before.risk+1e-6)reason='restart cannot sustain normal operating bill';
        }
        if(c.priority>=2&&!['campaign','opportunity'].includes(c.expert))for(const k of basics){const reserved=m.tasks.filter(t=>t.stage!=='exit'&&t.id!=='development:'+c.id).reduce((n,t)=>n+(t.reserve[k]??0),0);if(reserved>0&&preview.draft.factions[actor].resources[k]/1000<reserved+ledger(preview.draft,actor).reserves[k])reason='resources reserved for committed production task';}
        const welfare=c.actions.find(x=>x.type==='set_welfare');
        if(welfare&&c.expert!=='crisis'&&(after.risk>0||basics.some(k=>ledger(preview.draft,actor).normalNet[k]<0)||(world.factions[actor].welfare?.last?.fraction??1)<1))reason='welfare upgrade cannot cover full normal bill and reserves';
        if(c.actions.some(x=>x.type==='set_structure_status'||x.type==='set_jobs')) {
          const operating=structuredClone(preview.draft);
          for(const action of c.actions.filter(x=>x.type==='set_structure_status'&&x.args.sealed===false))for(const p of operating.systems.flatMap(s=>s.planets))for(const b of p.structures)if(b.id===action.args.structureId)delete b.restartUntil;
          const next=ledger(operating,actor);
          if(c.expert==='crisis'&&after.risk>=before.risk&&basics.every(k=>next.net[k]<=book.net[k]))reason='no shortage repair';
          if(c.expert==='economy'&&after.risk>=before.risk&&basics.every(k=>next.net[k]<=book.net[k])&&next.economy.net.alloys<=book.economy.net.alloys&&next.economy.effectiveUnityChange<=book.economy.effectiveUnityChange&&!c.actions.some(x=>x.type==='set_structure_status'&&x.args.sealed===false&&stage.draft.systems.flatMap(s=>s.planets).flatMap(p=>p.structures).some(b=>b.id===x.args.structureId&&['lrs','shipyard','drydock','maintenance'].includes(b.type))))reason='no operating benefit';
        }
      }
      if(reason){rejectedKeys.add(signature);report.sras!.counters!.rejected++;report.sras!.blocked.push({id:c.id,expert:c.expert,reason});if(report.sras!.previews>=SRAS.previews)break;continue;}
      c.dependencies=accepted.filter(g=>g.actions.some(a=>c.actions.some(b=>a.args.planetId&&a.args.planetId===b.args.planetId||a.args.fleetId&&a.args.fleetId===b.args.fleetId||a.type==='declare_war'&&b.type==='move_fleet'))).map(g=>g.id);
      // Commit this accepted group only; failed previews never mutate the shared prefix.
      for(const action of c.actions){const r=stage.execute(action.type,action.args);if(!r.ok)throw new Error('SRAS accepted prefix replay diverged: '+r.error);}
      accepted.push(c);chosen.add(c.id);merged ||= c.actions.some(a=>a.type==='merge_fleets');for(const action of c.actions)if(action.args.fleetId)militaryDone.add(String(action.args.fleetId));
      report.sras!.counters!.accepted++;
      m.tasks=proposed.tasks;
      for(const action of c.actions)for(const key of conflictKeys(action)){locks.add(key);if(key.startsWith('structure:')||key.startsWith('jobs:'))m.switches![key]={round:world.round,value:JSON.stringify(action.args)};}
      m.tasks=m.tasks.filter(t=>t.id!=='development:'+c.id);
      advanced=true;break;
    }
    if(!advanced){
      if(!fallback){fallback=true;continue;}
      // Persist diagnostic tasks only after the coordinated pass, not from a
      // discarded candidate preview. Remove tentative move assignments below.
      m.tasks=proposed.tasks;break;
    }
  }
  let kept=[...accepted];
  for(let attempt=1;attempt<=SRAS.validations;attempt++) {
    await checkpoint();const actions=kept.flatMap(c=>c.actions),final=validator(world,actor,actions);report.validations=attempt;
    if(final.ok) {
      if(accepted.length&&!kept.length)throw new Error('SRAS final repair removed every group; pause without empty fallback');
      report.sras!.actions=final.stage.actions.length;report.exhausted=report.sras!.previews>=SRAS.previews;
      report.sras!.fallback=fallbackChecks(final.stage.draft,actor,m,report.sras!.blocked);
      report.sras!.stop=final.stage.actions.length>=SRAS.actions?'action limit':report.exhausted?'preview budget exhausted; category usage recorded':report.sras!.blocked.length?'resource, staffing or safety blocked; fallback checked':'applicable recipes checked; waiting for paid completion, intelligence or task conditions';
      report.sras!.netChanges=final.stage.actions.length;
      if(final.stage.actions.length)m.lastActivityRound=world.round;
      // Only final surviving state may support fleet assignments and switches.
      const allocated=new Set<string>();
      for(const t of [...m.tasks].sort((x,y)=>Number(y.expert==='defense')-Number(x.expert==='defense')||x.id.localeCompare(y.id))){t.assets=t.assets.filter(id=>{const f=final.stage.draft.fleets.find(f=>f.id===id&&f.ownerId===actor);if(!f||allocated.has(id)||t.stage==='exit')return false;if(t.expert==='defense'&&f.systemId!==t.target&&f.order?.systemId!==t.target&&f.transit?.to!==t.target)return false;allocated.add(id);return true;});}
      const validSwitches=new Set(final.stage.actions.flatMap(conflictKeys));for(const [key,value]of Object.entries(m.switches!))if(value.round===world.round&&!validSwitches.has(key))delete m.switches![key];
      report.sras!.tasks=structuredClone(m.tasks);report.sras!.groups=accepted.map(g=>({id:g.id,expert:g.expert,actions:g.actions,dependencies:g.dependencies,status:kept.includes(g)?'accepted':'removed',reason:g.reason}));
      report.selected=kept.map(c=>({id:c.id,label:c.expert+': '+c.reason,actions:c.actions,fingerprint:failureDependency(world,actor,c.actions,'construction')}));
      report.sras!.blocked=report.sras!.blocked.slice(-128);
      const memory:ScriptMemory={version:'sras-v1',goal:null,tasks:[],failures:[],sras:m};
      return {actions:final.stage.actions,summary:`SRAS ${m.stage}: ${final.stage.actions.length} actions; ${report.sras!.stop}`,trace:final.stage.trace,scriptMemory:memory,scriptReport:report,metrics:{...emptyMetrics(),durationMs:performance.now()-start,reportedModel:'sras-v1'}};
    }
    report.rejected.push({attempt,index:final.index,reason:final.reason});
    if(attempt===SRAS.validations)throw new Error('SRAS final validation failed three times: '+final.reason);
    let count=0;const failed=kept.find(g=>{count+=g.actions.length;return count>final.index;});if(!failed)throw new Error('SRAS invalid failure index');
    const removed=new Set([failed.id]);for(const g of kept)if(g.dependencies.some(id=>removed.has(id)))removed.add(g.id);
    kept=kept.filter(g=>!removed.has(g.id));
  }
  throw new Error('SRAS validation incomplete');
}
