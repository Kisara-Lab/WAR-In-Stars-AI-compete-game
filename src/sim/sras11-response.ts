import { costs } from './sras11-experts.js';
import type {Action,GameState,Fleet} from '../shared/types.js';
import type {SrasMemory} from '../shared/sras11.js';
import {SRAS} from '../shared/sras11.js';
import {STRUCTURES,SHIPS,RULES} from '../shared/rules.js';
import {allocation,LABOR,support,capacity} from '../shared/industry.js';
import {constructionView} from '../shared/construction.js';
import {controller} from '../shared/v4.js';
import {settlementPreview} from '../shared/settlement-preview.js';
import {arrival,owned,ledger,group,move,remaining,ownPower,digest,coverage,knownDefense,type RuleGroup} from './sras11-rules.js';
import {fleetPower} from './math.js';

// Known movement only. Never use foreign stock, morale or placeholder populations.
export function knownArrival(s:GameState,a:string,f:Fleet,to:string) {
  if(f.systemId===to&&!f.transit)return 0;
  if(f.transit){const copy={...f,systemId:f.transit.to,transit:null,order:null};return f.transit.remainingDays+arrival(s,a,copy,to);}
  return arrival(s,a,{...f,order:null},to);
}
export function threatTable(s:GameState,a:string) {
  const hostile=new Set(Object.values(s.relations).filter(r=>r.status==='war'&&r.factions.includes(a)).flatMap(r=>r.factions.filter(x=>x!==a)));
  const homes=owned(s,a),table=new Map<string,{system:string;power:number;arrival:number;fleets:string[]}>();
  for(const f of s.fleets.filter(f=>hostile.has(f.ownerId)).sort((x,y)=>x.id.localeCompare(y.id))){
    const intended=f.order?.systemId??f.transit?.to;
    const choices=homes.map(h=>({h,eta:knownArrival(s,f.ownerId,f,h.id)})).filter(x=>x.eta<=SRAS.reserveDays).sort((x,y)=>Number(y.h.id===intended)-Number(x.h.id===intended)||x.eta-y.eta||x.h.id.localeCompare(y.h.id));
    const next=choices[0];if(!next)continue;
    const row=table.get(next.h.id)??{system:next.h.id,power:0,arrival:Infinity,fleets:[]};row.power+=fleetPower(f);row.arrival=Math.min(row.arrival,next.eta);row.fleets.push(f.id);table.set(next.h.id,row);
  }
  return [...table.values()].sort((x,y)=>x.arrival-y.arrival||x.system.localeCompare(y.system));
}
export function situation(s:GameState,a:string) {
  const homes=owned(s,a),war=s.wars?.some(w=>w.endedDay===undefined&&w.factions.includes(a)),threats=threatTable(s,a),book=ledger(s,a);
  const yards=homes.flatMap(h=>h.planets.filter(p=>p.ownerId===a&&support({...p,operation:undefined},'shipyard',s.day)===1));
  const blockedBill=(s.factions[a].welfare?.last?.reachablePopulation??0)<(s.factions[a].welfare?.last?.population??0);
  const flags=[...(blockedBill?['welfare-delivery-blocked']:[]),...(book.risk>0||Object.values(s.factions[a].shortages).some(Boolean)?['supply-interrupted']:[]),...(war?['under-attack']:[]),...(war&&!yards.length?['core-capacity-lost']:[]),...(war&&(!s.fleets.some(f=>f.ownerId===a)||homes.length<=2)?['survival-emergency']:[])];
  return {flags:flags.length?flags:['normal-development'],threats,war:!!war,yards,homes};
}
export function conflictKeys(action:Action):string[] {
  const x=action.args;
  if(['confirm_contact','declare_war','enforce_peace','propose_peace','accept_peace','reject_peace','withdraw_peace','open_borders','close_borders'].includes(action.type)) {
    const category=['open_borders','close_borders'].includes(action.type)?'access':'relation';
    return [`diplomacy:${String(x.factionId)}:${category}`];
  }
  if(action.type==='set_structure_status'||action.type==='scrap_structure')return ['structure:'+x.structureId];
  if(action.type==='set_jobs')return ['jobs:'+x.planetId+':'+x.structureType];
  if(action.type==='set_welfare'||action.type==='choose_policy')return [action.type];
  if(action.type==='merge_fleets')return (x.fleetIds as string[]).map(id=>'fleet:'+id);
  if(x.fleetId)return ['fleet:'+x.fleetId];
  if(action.type==='cancel_order')return ['project:'+x.projectId];
  return [];
}
export function intentKeys(s:GameState,action:Action):string[] {
  const keys=conflictKeys(action),x=action.args;
  if(action.type==='build_structure')keys.push(`investment:${x.planetId}:building:${x.structureType}`);
  if(action.type==='queue_ships')keys.push(`investment:${x.planetId}:ship:${x.shipType}`);
  if(action.type==='cancel_order'){
    const q=s.systems.flatMap(h=>h.projects).find(q=>q.id===x.projectId);
    if(q)keys.push(`investment:${q.planetId}:${q.kind}:${q.structureType??q.shipType}`);
  }
  return keys;
}
export function candidateDependency(s:GameState,a:string,c:RuleGroup) {
  const planetIds=new Set(c.actions.map(x=>x.args.planetId)),fleetIds=new Set(c.actions.flatMap(x=>[x.args.fleetId,...(Array.isArray(x.args.fleetIds)?x.args.fleetIds:[])]));
  const systems=new Set(c.actions.map(x=>x.args.systemId)),price=costs(c.actions),book=ledger(s,a);
  const funding=Object.fromEntries(Object.entries(price).filter(([,n])=>n>0).map(([k,n])=>[k,(s.factions[a].resources[k as 'minerals']??0)>=n]));
  const supply=(['energy','food','minerals'] as const).map(k=>[k,book.deficits[k]>0,book.normalNet[k]<0]);
  return digest({actions:c.actions,funding,supply,policy:s.factions[a].policy?.choice,welfare:s.factions[a].welfare?.choice,planets:s.systems.flatMap(x=>x.planets.filter(p=>planetIds.has(p.id))),queues:s.systems.flatMap(x=>x.projects.filter(p=>planetIds.has(p.planetId))),fleets:s.fleets.filter(f=>fleetIds.has(f.id)),targets:s.systems.filter(h=>systems.has(h.id)).map(h=>[h.id,controller(h),h.projects.filter(q=>q.ownerId===a)]),relations:c.actions.some(x=>['move_fleet','declare_war'].includes(x.type))?s.relations:undefined});
}
export function campaignDependency(s:GameState,a:string,target:string) {
  const intel=knownDefense(s,a,target),system=s.systems.find(x=>x.id===target);
  const border=new Set(system?.neighbors.filter(id=>owned(s,a).some(h=>h.id===id))??[]);
  const ready=s.fleets.filter(f=>f.ownerId===a&&f.systemId&&border.has(f.systemId)&&!f.order&&!f.transit).reduce((n,f)=>n+ownPower(s,a,f),0);
  return digest({target:system?[system.id,controller(system),system.base]:null,intel:intel?{known:true,power:intel.power}:null,ready:intel?ready>=Math.max(SRAS.minimumFleetPower,intel.power*SRAS.attackRatio):false,relations:Object.values(s.relations).filter(r=>r.factions.includes(a)&&r.factions.includes(system?.ownerId??'')).map(r=>({status:r.status,pactUntil:r.pactUntil}))});
}
export function threatAlternatives(s:GameState,a:string) {
  const enemies=new Set(Object.values(s.relations).filter(r=>r.status==='war'&&r.factions.includes(a)).flatMap(r=>r.factions.filter(x=>x!==a)));
  return s.fleets.filter(f=>enemies.has(f.ownerId)).sort((x,y)=>x.id.localeCompare(y.id)).map(f=>({fleet:f.id,alternatives:owned(s,a).map(h=>({system:h.id,arrival:knownArrival(s,f.ownerId,f,h.id)})).filter(x=>x.arrival<=SRAS.reserveDays).sort((x,y)=>x.arrival-y.arrival||x.system.localeCompare(y.system))}));
}
export function fallbackChecks(s:GameState,a:string,m:SrasMemory,blocked:{expert:string;reason:string}[]) {
  const ctx=situation(s,a),book=ledger(s,a),planets=ctx.homes.flatMap(h=>h.planets.filter(p=>p.ownerId===a));
  const queues=ctx.homes.flatMap(h=>h.planets.filter(p=>p.ownerId===a).flatMap(p=>constructionView(s,h,p).queues.flatMap(q=>q.projects.map(x=>({id:x.id,complete:x.estimatedCompleteDay,paused:x.paused})))));
  const idle=planets.map(p=>{const jobs=allocation({...p,operation:undefined},s.day);return {planet:p.id,idle:p.population-p.structures.reduce((n,b)=>n+(jobs[b.id]??0)*LABOR[b.type].jobs,0)};}).filter(x=>x.idle>0);
  const rows:[string,unknown,boolean][]=[
    ['basic supply',{normalNet:book.normalNet,deficits:book.deficits},book.risk>0],
    ['idle labor',idle,idle.length>0],
    ['sealed capacity',planets.flatMap(p=>p.structures.filter(b=>b.sealed).map(b=>({planet:p.id,id:b.id,type:b.type}))),planets.some(p=>p.structures.some(b=>b.sealed))],
    ['core facilities',{operatingYards:ctx.yards.map(p=>p.id),queues},ctx.flags.includes('core-capacity-lost')],
    ['legal construction',{planets:planets.map(p=>({id:p.id,ground:capacity(p,'ground'),orbital:capacity(p,'orbital'),population:p.population})),queues},planets.length>0],
    ['military response',{threats:ctx.threats,fleets:s.fleets.filter(f=>f.ownerId===a).map(f=>({id:f.id,order:f.order,transit:f.transit})),tasks:m.tasks.filter(t=>t.expert==='defense')},ctx.threats.length>0],
    ['intelligence',m.tasks.filter(t=>t.stage==='recon'),m.tasks.some(t=>t.stage==='recon')],
    ['war settlement',s.wars?.filter(w=>w.endedDay===undefined&&w.factions.includes(a)).map(w=>settlementPreview(s,a,w))??[],ctx.war],
    ['diplomatic escape',{offers:Object.values(s.relations).filter(r=>r.factions.includes(a)&&r.status==='war').map(r=>({factions:r.factions,offers:r.offers})),blocked:blocked.filter(x=>x.expert==='diplomacy')},ctx.war],
  ];
  return rows.map(([check,evidence,applicable])=>({check,status:applicable?'checked; remaining constraints recorded':'not applicable',reason:JSON.stringify(evidence)}));
}

// Fixed recipes, no beam search/forecast. Normal validators remain authoritative.
export function responseRules(s:GameState,a:string,m:SrasMemory):RuleGroup[] {
  const ctx=situation(s,a),result:RuleGroup[]=[],book=ledger(s,a),left=remaining(s);
  const critical=ctx.flags.includes('core-capacity-lost')||ctx.flags.includes('survival-emergency');
  for(const h of ctx.homes)for(const p of h.planets.filter(p=>p.ownerId===a)){
    const jobs=allocation({...p,operation:undefined},s.day),queue=h.projects.filter(q=>q.planetId===p.id),threat=ctx.threats.find(t=>t.system===h.id);
    const needs: (keyof typeof STRUCTURES)[]=[];
    if(critical&&!ctx.yards.length&&!ctx.homes.some(x=>x.projects.some(q=>q.structureType==='shipyard')))needs.push('shipyard');
    if(m.tasks.some(t=>t.stage==='recon'&&coverage(s,h.id).has(t.target)))needs.push('lrs');
    for(const type of ['farm','solar','mine'] as const){const k=type==='farm'?'food':type==='solar'?'energy':'minerals';if(book.deficits[k]>0)needs.push(type);}
    for(const type of needs){
      const b=p.structures.find(b=>b.type===type),priority=type==='shipyard'?0:book.risk>0?0:2;
      if(b){const actions:Action[]=[];if(b.sealed)actions.push({type:'set_structure_status',args:{planetId:p.id,structureId:b.id,sealed:false}});if((jobs[b.id]??0)<1&&(p.priorities?.[type]??LABOR[type].priority)!==5)actions.push({type:'set_jobs',args:{planetId:p.id,structureType:type,priority:5}});if(actions.length)result.push(group('crisis',priority,110,actions,'restore required '+type+' with staffing'));continue;}
      if(queue.some(q=>q.structureType===type)||left<STRUCTURES[type].days)continue;
      if(threat&&threat.arrival<STRUCTURES[type].days&&(h.base?.hull??0)<threat.power)continue;
      const used=p.structures.filter(b=>STRUCTURES[b.type].slot===STRUCTURES[type].slot).length+queue.filter(q=>q.structureType&&STRUCTURES[q.structureType].slot===STRUCTURES[type].slot).length;
      if(used>=capacity(p,STRUCTURES[type].slot)){if(!queue.some(q=>q.kind==='expansion'))result.push(group('crisis',priority,100,[{type:'expand_slots',args:{planetId:p.id,slot:STRUCTURES[type].slot}}],'expand slot for required '+type));continue;}
      const actions:Action[]=[];
      let free=p.population-p.structures.filter(b=>!b.sealed).reduce((n,b)=>n+LABOR[b.type].jobs,0)-queue.reduce((n,q)=>n+(q.structureType?LABOR[q.structureType].jobs:0),0);
      for(const spare of p.structures.filter(b=>!b.sealed&&['hospital','resort','maintenance','refinery','agriculture','solar_hub'].includes(b.type)).sort((x,y)=>x.id.localeCompare(y.id))){if(free>=LABOR[type].jobs)break;actions.push({type:'set_structure_status',args:{planetId:p.id,structureId:spare.id,sealed:true}});free+=LABOR[spare.type].jobs;}
      if(free>=LABOR[type].jobs)result.push(group('crisis',priority,100,[...actions,{type:'build_structure',args:{planetId:p.id,structureType:type}}],'recover required '+type+' capacity with released labor'));
    }
  }
  if(critical)for(const war of s.wars?.filter(w=>w.endedDay===undefined&&w.factions.includes(a))??[]){
    const opponent=war.factions.find(x=>x!==a)!,view=settlementPreview(s,a,war),rel=Object.values(s.relations).find(r=>r.factions.includes(a)&&r.factions.includes(opponent));
    if(!view||!rel)continue;const returned=view.unconditional.returnOccupations.filter(x=>x.from===a);
    if(!returned.length&&(rel.offers[opponent]?.createdRound??s.round)<s.round)result.push(group('diplomacy',0,115,[{type:'accept_peace',args:{factionId:opponent}}],'survival peace; returns no held gains'));
    else if(!returned.length&&!rel.offers[a])result.push(group('diplomacy',0,110,[{type:'propose_peace',args:{factionId:opponent}}],'survival peace proposal; returns no held gains; acceptance not guaranteed'));
  }
  // Evacuate fleets from lost or overwhelming contacts to a reachable safer home.
  for(const f of s.fleets.filter(f=>f.ownerId===a&&f.systemId&&!f.order&&!f.transit&&!f.withdrawal)){
    const hostile=s.fleets.filter(e=>e.ownerId!==a&&e.systemId===f.systemId&&Object.values(s.relations).some(r=>r.status==='war'&&r.factions.includes(a)&&r.factions.includes(e.ownerId))).reduce((n,e)=>n+fleetPower(e),0);
    const local=s.fleets.filter(e=>e.ownerId===a&&e.systemId===f.systemId).reduce((n,e)=>n+ownPower(s,a,e),0)+(controller(s.systems.find(h=>h.id===f.systemId)!)===a?(s.systems.find(h=>h.id===f.systemId)?.base?.hull??0):0);
    if(hostile<=local)continue;
    const safe=ctx.homes.filter(h=>h.id!==f.systemId&&!ctx.threats.some(t=>t.system===h.id)).map(h=>({h,eta:arrival(s,a,f,h.id)})).filter(x=>Number.isFinite(x.eta)).sort((x,y)=>x.eta-y.eta||x.h.id.localeCompare(y.h.id))[0];
    if(safe)result.push(group('defense',0,120,[move(f.id,safe.h.id)],'withdraw outmatched fleet to safe owned rally'));
  }
  return result;
}
