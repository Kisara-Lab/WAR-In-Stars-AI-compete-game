import { createHash } from 'node:crypto';
import { policyComparison } from '../shared/comparison.js';
import { welfareQuote, route, CIVILIZATION } from '../shared/civilization.js';
import { currentPolicy } from '../shared/civil.js';
import { constructionView } from '../shared/construction.js';
import { allocation, LABOR, support } from '../shared/industry.js';
import { RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import type { Action, Fleet, GameState } from '../shared/types.js';
import { SRAS, type Expert } from '../shared/sras.js';
import { controller, occupied, faithEffects } from '../shared/v4.js';
import { accessiblePath } from './diplomacy.js';
import { distance, fleetPower, shortageMultiplier } from './math.js';

export const basics = ['energy', 'food', 'minerals'] as const;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface RuleGroup {id: string; expert: Expert; priority: number; rank: number; actions: Action[]; reason: string; dependencies: string[]}
export const group = (expert: Expert, priority: number, rank: number, actions: Action[], reason: string): RuleGroup => ({id:digest(actions),expert,priority,rank,actions,reason,dependencies:[]});
export const owned = (s: GameState, a: string) => s.systems.filter(x => x.ownerId === a && !occupied(x)).sort((x,y)=>x.id.localeCompare(y.id));
export const remaining = (s: GameState) => Math.max(0,(s.config.maxRounds-s.round)*RULES.daysPerRound);
export const ownPower=(s:GameState,a:string,f:Fleet)=>fleetPower(f)*shortageMultiplier(s.factions[a].shortages)*currentPolicy(s,a).combat*faithEffects(s.factions[a],s.day).combat*(route(s,a)==='militarist'?CIVILIZATION.militaryCombat:1)*(s.factions[a].policy?.choice==='exercises'?CIVILIZATION.exerciseCombat:1);
export function ledger(s: GameState, a: string) {
  const f=s.factions[a], choice=f.policy?.choice??'none';
  const economy=policyComparison(s,a,[choice])[0];
  const normalState={...s,factions:{...s.factions,[a]:{...f,shortages:{energy:false,food:false,minerals:false}}}};
  const normal=policyComparison(normalState,a,[choice])[0];
  const quote=welfareQuote(s,a), days=Math.min(SRAS.reserveDays,remaining(s));
  // Charge the promised bill, including currently unpaid welfare. Aid/extraction grants
  // are deliberately absent from policyComparison and never treated as recurring income.
  const net=Object.fromEntries(basics.map(k=>[k,economy.net[k]+economy.welfarePaid[k]-quote.deliverable[k]/1000]));
  const normalNet=Object.fromEntries(basics.map(k=>[k,normal.net[k]+normal.welfarePaid[k]-quote.deliverable[k]/1000]));
  const reserves=Object.fromEntries(basics.map(k=>[k,Math.max(0,-net[k]*days/100)]));
  const deficits=Object.fromEntries(basics.map(k=>[k,Math.max(0,reserves[k]-f.resources[k]/1000)]));
  return {net,normalNet,reserves,deficits,days,risk:Object.values(deficits).reduce((n,x)=>n+x,0),economy};
}
export function coverage(s:GameState, systemId:string) {
  const ids=new Set([systemId]);
  for(let step=0;step<2;step++)for(const id of [...ids])for(const n of s.systems.find(x=>x.id===id)?.neighbors??[])ids.add(n);
  return ids;
}
export function sensorGain(s:GameState,a:string,systemId:string) {
  const covered=new Set<string>();
  for(const system of owned(s,a))if(system.planets.some(p=>support({...p,operation:undefined},'lrs',s.day)===1)||system.projects.some(p=>p.structureType==='lrs'))for(const id of coverage(s,system.id))covered.add(id);
  return [...coverage(s,systemId)].filter(id=>!covered.has(id)&&s.systems.find(x=>x.id===id)?.ownerId!==a);
}
export function buildingUseful(s:GameState,a:string,planetId:string,type:keyof typeof STRUCTURES) {
  const system=s.systems.find(x=>x.planets.some(p=>p.id===planetId))!,p=system.planets.find(p=>p.id===planetId)!;
  if(type==='lrs')return sensorGain(s,a,system.id).length>0;
  if(type==='drydock')return support({...p,operation:undefined},'shipyard',s.day)===1&&system.projects.filter(q=>q.planetId===p.id&&q.kind==='ship').length>=2;
  if(type==='maintenance')return s.fleets.some(f=>f.ownerId===a&&f.systemId===system.id&&!f.transit&&f.ships.length>=3);
  if(type==='refinery')return p.structures.filter(b=>b.type==='mine'&&!b.sealed).length>=2;
  if(type==='agriculture')return p.structures.filter(b=>b.type==='farm'&&!b.sealed).length>=2;
  if(type==='solar_hub')return p.structures.filter(b=>b.type==='solar'&&!b.sealed).length>=2;
  return true;
}
export function staffed(s:GameState,a:string,planetId:string,type:keyof typeof STRUCTURES) {
  const p=s.systems.flatMap(x=>x.planets).find(x=>x.id===planetId)!;
  const paid=s.systems.flatMap(x=>x.projects).filter(q=>q.planetId===planetId&&q.structureType).reduce((n,q)=>n+LABOR[q.structureType!].jobs,0);
  const employed=p.structures.filter(b=>!b.sealed).reduce((n,b)=>n+LABOR[b.type].jobs,0);
  return p.population-employed-paid>=LABOR[type].jobs;
}
export const move = (fleetId:string,systemId:string):Action=>({type:'move_fleet',args:{fleetId,systemId,x:null,y:null,targetFleetId:null}});
export function arrival(s:GameState,a:string,f:Fleet,target:string) {
  if(!f.systemId||f.transit||f.order)return Infinity;
  const path=accessiblePath(s,a,f.systemId,target,true);if(!path)return Infinity;
  const speed=Math.min(...f.ships.map(x=>SHIPS[x.type].speed));
  return path.reduce((days,id,index)=>{const from=s.systems.find(x=>x.id===(index?path[index-1]:f.systemId))!;return days+RULES.jumpDays+Math.ceil((index?Math.SQRT2*1000:distance(f.position,from.gates[id]))/speed/10)*10;},0);
}
export function knownDefense(s:GameState,a:string,target:string) {
  const f=s.factions[a],mil=f.militaryIntel?.[target],col=f.intel[target];
  const latest=mil&&mil.day>=(col?.day??-1)?{day:mil.day,base:mil.base,fleets:mil.fleets}:col?{day:col.day,base:col.system.base,fleets:col.fleets}:null;
  if(!latest||s.day-latest.day>SRAS.intelDays)return null;
  return {day:latest.day,power:(latest.base?.hull??0)+latest.fleets.filter(x=>x.ownerId!==a).reduce((n,x)=>n+fleetPower(x),0)};
}
export function safeContactPath(s:GameState,a:string,action:Action) {
  if(action.type!=='move_fleet')return true;
  const fleet=s.fleets.find(f=>f.ownerId===a&&f.id===action.args.fleetId);if(!fleet?.systemId)return false;
  const path=accessiblePath(s,a,fleet.systemId,String(action.args.systemId),true);if(!path)return false;
  for(const id of path) {
    const system=s.systems.find(x=>x.id===id)!;
    if(system.ownerId===a)continue;
    const known=knownDefense(s,a,id);if(!known)return false;
    const hostile=system.ownerId&&Object.values(s.relations).some(r=>r.factions.includes(a)&&r.factions.includes(system.ownerId!)&&r.status==='war');
    if(hostile&&ownPower(s,a,fleet)<known.power*SRAS.attackRatio)return false;
  }
  return true;
}
export function deadlineSafe(s:GameState,a:string,previous:GameState) {
  const prior=new Set(previous.systems.flatMap(x=>x.projects).map(x=>x.id));
  for(const system of owned(s,a))for(const p of system.planets.filter(p=>p.ownerId===a))for(const q of constructionView(s,system,p).queues.flatMap(x=>x.projects))if(!prior.has(q.id)&&(q.estimatedCompleteDay===null||q.estimatedCompleteDay>s.day+remaining(s)))return false;
  return true;
}
export function failureDependency(s:GameState,a:string,actions:Action[],category:string) {
  if(category==='resources')return digest(s.factions[a].resources);
  const ids=new Set(actions.flatMap(x=>Object.values(x.args).flat().filter((v):v is string=>typeof v==='string')));
  if(category==='passage')return digest({relations:s.relations,owners:s.systems.map(x=>[x.id,controller(x)])});
  if(category==='fleet')return digest(s.fleets.filter(x=>x.ownerId===a&&ids.has(x.id)));
  return digest({intel:[...ids].map(id=>[id,s.factions[a].intel[id]?.day,s.factions[a].militaryIntel?.[id]?.day]),planets:s.systems.flatMap(x=>x.planets.filter(p=>ids.has(p.id))),projects:s.systems.flatMap(x=>x.projects.filter(p=>ids.has(p.id)||ids.has(p.planetId??'')))});
}
export function failureCategory(reason:string) {return /资源|不足|费用|余额/.test(reason)?'resources':/通行|闭境|边境|路径/.test(reason)?'passage':/舰队|fleet/i.test(reason)?'fleet':'construction';}
