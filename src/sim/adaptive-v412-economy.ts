import { STRUCTURES } from '../shared/rules.js';
import { policyComparison } from '../shared/comparison.js';
import { industryPlanet } from '../shared/industry.js';
import type { GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { economicForecast } from './forecast.js';
import { recoveryCandidatesV4, economicCandidatesV4, emptyRiskV4 } from './adaptive-v4-economy.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import type { MilitaryOptionV412, CapacityV412 } from '../shared/adaptive-v412.js';
import { constructionView } from '../shared/construction.js';
import { SHIPS } from '../shared/rules.js';
import { controller } from '../shared/v4.js';
import { arrivalV412 } from './adaptive-v412-military.js';
import { paidReinforcementsV412 } from './adaptive-v412-memory.js';
import { shipMaterials } from '../shared/industry.js';

/** Build repairs for the deficient inputs, not every operating building in the empire. */
export function economyCandidatesV412(state:GameState,actor:string,base:ScriptCandidate[],projection:ReturnType<typeof economicForecast>,memory?:ScriptMemory,plans:MilitaryOptionV412[]=[],capacity?:CapacityV412) {
  const own=state.factions[actor],last=projection.horizons.at(-1)!,sample=projection.trajectory?.find(t=>t.day===state.day+Math.min(300,(state.config.maxRounds-state.round)*100))??projection.trajectory?.at(-1),risk=structuredClone(sample?.risk??emptyRiskV4());
  risk.unpaidSeverity=sample?.causes?.fundingSeverity??risk.unpaidSeverity;
  risk.unpaidDays=sample?.causes?.fundingDays??risk.unpaidDays;
  const quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  if(risk.unpaidSeverity>0)for(const resource of ['energy','food','minerals'] as const)if((last.resources[resource]??0)<1)risk.shortfall[resource]=Math.max(risk.shortfall[resource],1);
  risk.value=risk.shortageDays+risk.unpaidSeverity;
  const scarce=(['energy','food','minerals'] as const).filter(r=>risk.shortfall[r]>0);
  const buildings=new Map(state.systems.flatMap(s=>s.planets.flatMap(p=>p.structures.map(b=>[b.id,{b,p}] as const))));
  const recoveryState={...state,factions:{...state.factions,[actor]:{...own,welfare:own.welfare?{...own.welfare,last:own.welfare.last?{...own.welfare.last,fraction:1}:undefined}:undefined}}};
  const recovery=recoveryCandidatesV4(recoveryState,actor,base,risk).flatMap(c=>{
    let gain=0;
    const actions=c.actions.filter(a=>{
      if(a.type!=='set_structure_status'||a.args.sealed!==true)return true;
      const item=buildings.get(String(a.args.structureId));if(!item)return false;
      const rule=STRUCTURES[item.b.type];
      if(scarce.some(r=>rule.output[r]>0)||scarce.includes('food')&&item.b.type==='agriculture'||scarce.includes('energy')&&item.b.type==='solar_hub')return false;
      const workforce=industryPlanet({...item.p,operation:undefined},state.day),vacant=workforce.population-workforce.employed;
      const release=vacant===0&&scarce.some(r=>item.p.structures.some(b=>STRUCTURES[b.type].output[r]>0));
      const saved=(scarce.includes('energy')?rule.energy:0)+(scarce.includes('minerals')?rule.upkeep+(item.b.type==='foundry'?40:0):0);
      if(!saved&&!release)return false;
      gain+=saved+(release?20:0);return true;
    });
    if(!actions.length)return [];
    const produces=actions.some(a=>a.type==='build_structure');
    const isSocial=actions.some(a=>!['set_jobs','set_structure_status','build_structure'].includes(a.type));
    if(!gain&&!produces&&!isSocial&&!actions.some(a=>a.type==='set_jobs'))return [];
    return [{...c,actions,id:'v412:repair:'+JSON.stringify(actions),value:gain||c.value,priority:scarce.length?3:1}];
  });
  const economic:ScriptCandidate[]=economicCandidatesV4(state,actor,base.filter(c=>c.kind!=='ships'&&!(own.civilization?.choice==='militarist'&&c.kind==='welfare'&&c.actions.some(a=>!['comfortable','basic','survival'].includes(String(a.args.welfare))))));
  // Current historical welfare payment is not a forecast of permanent insolvency.
  const near=projection.horizons.find(h=>h.days>=300)??projection.horizons[0];
  // Occupied delivery and responsibility pressure must not hide military options.
  // Affordability and forecasted maintenance are checked on the resulting draft.
  const paid=paidReinforcementsV412(state,actor);
  for(const c of base.filter(c=>c.kind==='ships')) {
    const planet=state.systems.flatMap(s=>s.planets).find(p=>p.id===c.target),system=state.systems.find(s=>s.planets.some(p=>p.id===c.target));
    if(!planet||!system||controller(system)!==actor)continue;
    const order=c.actions.find(a=>a.type==='queue_ships')!,type=order.args.shipType as keyof typeof SHIPS;
    const count=Number(order.args.count);
    const projectedFleet={id:'v412-order',ownerId:actor,name:'planned',systemId:system.id,position:{x:500,y:500},transit:null,order:null,ships:[{id:'planned',type,hull:SHIPS[type].power}]};

    const newIds=Array.from({length:count},(_,i)=>'v412-new-order-'+i);
    const scheduled={...system,projects:[...system.projects,...newIds.map(id=>({id,ownerId:actor,kind:'ship' as const,planetId:planet.id,shipType:type,structureType:null,createdDay:state.day,progress:0,requiredDays:SHIPS[type].days,cost:shipMaterials(type)}))]};
    const queued=constructionView(state,scheduled,planet).queues.find(q=>q.slot==='ship')!.projects;
    const finish=Math.max(...queued.filter(p=>newIds.includes(p.id)).map(p=>p.estimatedCompleteDay??Infinity));
    const options=(capacity?.needs??[]).map(need=>({need,arrival:Math.ceil(finish/100)*100+arrivalV412(state,actor,projectedFleet,need.target)}))
      .filter(x=>x.need.missing>0&&Number.isFinite(x.arrival)).sort((a,b)=>Number(b.arrival<=b.need.deadline)-Number(a.arrival<=a.need.deadline)||Number(b.need.kind==='defend')-Number(a.need.kind==='defend')||a.arrival-b.arrival||a.need.id.localeCompare(b.need.id));
    const selected=options[0],inTime=selected&&selected.arrival<=selected.need.deadline;
    const missing=selected?.need.missing??0;
    economic.push({...c,priority:inTime?3:c.priority,value:c.value+(inTime?Math.min(missing,SHIPS[type].power*count):0),reason:c.reason+JSON.stringify({task:selected?.need.id,finish,arrival:selected?.arrival,deadline:selected?.need.deadline,missing,inTime:!!inTime,lateSupport:!!selected&&!inTime}),deadline:selected?.arrival??finish});

  }
  // The light screen guarantees each kind/resource/planet an entry; exact acceptance remains forecast-based.
  for(const c of economic) {
    if(c.kind==='build'&&c.actions.some(a=>scarce.some(r=>STRUCTURES[a.args.structureType as keyof typeof STRUCTURES]?.output[r]>0)))c.priority=Math.max(c.priority,3);
    if(c.kind==='jobs') {
      const a=c.actions[0],p=state.systems.flatMap(s=>s.planets).find(p=>p.id===a.args.planetId);
      if(p&&industryPlanet({...p,operation:undefined},state.day).population>=industryPlanet({...p,operation:undefined},state.day).jobs)c.value=0;
    }
    if(c.kind==='build'&&c.actions.some(a=>['shipyard','drydock','foundry'].includes(String(a.args.structureType)))&&capacity?.needs.some(n=>n.missing>0&&n.deadline>state.day+300)) {
      c.priority=Math.max(c.priority,2);c.reason+='; capacity gap: compare completion, staffing and paid queue';
    }
    if(c.kind==='welfare'&&quote.effectiveUnityChange<0)c.priority=Math.max(c.priority,2);
  }
  const protectedProjects=new Set((memory?.operation as import('../shared/adaptive-v412.js').CampaignV412|undefined)?.waves?.flatMap(w=>w.projects.map(p=>p.id))??[]);
  return [...recovery,...economic].filter(c=>!c.actions.some(a=>a.type==='cancel_order'&&protectedProjects.has(String(a.args.projectId))));
}
