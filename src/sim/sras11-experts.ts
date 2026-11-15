import type { Action, GameState } from '../shared/types.js';
import type { SrasMemory } from '../shared/sras11.js';
import { SRAS } from '../shared/sras11.js';
import { STRUCTURES, SHIPS, BASE, RULES } from '../shared/rules.js';
import { allocation, LABOR, capacity, populationCap, shipMaterials } from '../shared/industry.js';
import { constructionView } from '../shared/construction.js';
import { responsibilityView } from '../shared/responsibility.js';
import { emergencyView } from '../shared/emergency.js';
import { route, civilizationEligibility } from '../shared/civilization.js';
import { basics, owned, ledger, group, remaining, knownDefense, ownPower, type RuleGroup } from './sras11-rules.js';

/** Costs in world integer units. Unknown commands remain subject to the validator. */
export function costs(actions:Action[]) {
  const price:Record<string,number>={energy:0,food:0,minerals:0,alloys:0};
  for(const x of actions){
    if(x.type==='build_structure'){const type=x.args.structureType as keyof typeof STRUCTURES;price.minerals+=STRUCTURES[type].minerals*1000;price.alloys+=LABOR[type].alloys*1000;}
    if(x.type==='queue_ships')for(const [key,value]of Object.entries(shipMaterials(x.args.shipType as keyof typeof SHIPS)))price[key]+=(value??0)*Number(x.args.count);
    if(x.type==='build_starbase')price.minerals+=BASE.minerals*1000;
    if(x.type==='colonize_planet'){price.minerals+=RULES.colonizeMinerals*1000;price.food+=RULES.colonizeFood*1000;}
  }
  return price;
}
export function funding(s:GameState,a:string,actions:Action[]) {
  const price=costs(actions),book=ledger(s,a);
  const gaps=Object.entries(price).filter(([k,n])=>n>(s.factions[a].resources[k as keyof typeof s.factions[string]['resources']]??0)).map(([resource,n])=>{
    const gap=(n-(s.factions[a].resources[resource as 'minerals']??0))/1000,net=book.normalNet[resource]??book.economy.net.alloys??0;
    return {resource,gap,normalNet:net,earliestDay:net>0?s.day+Math.ceil(gap/net*100):null};
  });
  return {price,gaps};
}

/** Paid hulls count once. A mobilization has a finite target, not endless queue filling. */
export function fleetDemand(s:GameState,a:string,m:SrasMemory) {
  const campaign=m.tasks.find(t=>t.expert==='campaign'&&t.stage!=='exit');
  const target=campaign?knownDefense(s,a,campaign.target):null;
  const defense=m.tasks.filter(t=>t.expert==='defense'&&t.stage!=='exit').reduce((n,t)=>n+(t.requiredPower??0),0);
  const border=owned(s,a).filter(h=>h.neighbors.some(id=>s.systems.some(x=>x.id===id&&x.ownerId&&x.ownerId!==a))).length;
  let desired=defense+(target?Math.max(SRAS.minimumFleetPower,target.power*SRAS.attackRatio):Math.max(SRAS.minimumFleetPower,border*SRAS.borderPower));
  const current=s.fleets.filter(f=>f.ownerId===a).reduce((n,f)=>n+ownPower(s,a,f),0);
  let paid=0;
  for(const h of owned(s,a))for(const p of h.planets.filter(p=>p.ownerId===a))for(const q of constructionView(s,h,p).queues.flatMap(q=>q.projects)){
    const project=h.projects.find(x=>x.id===q.id);
    if(project?.shipType&&q.estimatedCompleteDay!==null&&q.estimatedCompleteDay<s.day+Math.min(remaining(s),SRAS.reserveDays*2))paid+=SHIPS[project.shipType].power;
  }
  // Endgame score conversion is an explicit task: only liquid surplus beyond
  // the linear operating reserve may fund hulls that can finish in time.
  if(['realization','endgame'].includes(m.stage)&&remaining(s)>SHIPS.destroyer.days){
    const book=ledger(s,a),f=s.factions[a];
    const surplus=Math.max(0,f.resources.minerals/1000-book.reserves.minerals-SRAS.terminalReserve);
    const alloy=Math.max(0,(f.resources.alloys??0)/1000-SRAS.terminalAlloys);
    if(book.risk===0&&basics.every(k=>book.normalNet[k]>=0))desired=Math.max(desired,current+paid+Math.min(surplus,alloy)/2);
  }
  return {desired,current,paid,gap:Math.max(0,desired-current-paid)};
}

/** Fallback contains real recipes, not just a list of facts. */
export function fallbackRules(s:GameState,a:string,m:SrasMemory):RuleGroup[] {
  const out:RuleGroup[]=[],book=ledger(s,a),left=remaining(s);
  for(const h of owned(s,a))for(const p of h.planets.filter(p=>p.ownerId===a).sort((x,y)=>x.id.localeCompare(y.id))){
    const jobs=allocation({...p,operation:undefined},s.day),queue=h.projects.filter(q=>q.planetId===p.id);
    const free=p.population-p.structures.filter(b=>!b.sealed).reduce((n,b)=>n+LABOR[b.type].jobs,0)-queue.reduce((n,q)=>n+(q.structureType?LABOR[q.structureType].jobs:0),0);
    // Fixed labor recovery: a priority command alone may leave an essential site understaffed.
    for(const b of p.structures.filter(b=>['mine','farm','solar','shipyard','lrs','foundry'].includes(b.type))){
      const resource=b.type==='mine'?'minerals':b.type==='farm'?'food':b.type==='solar'?'energy':null;
      const needed=resource?book.normalNet[resource]<0: b.type==='shipyard'?fleetDemand(s,a,m).gap>0:b.type==='lrs'?m.tasks.some(t=>t.stage==='recon'):fleetDemand(s,a,m).gap>0&&book.normalNet.minerals>SRAS.foundryMineralMargin;
      if(!needed||!b.sealed&&(jobs[b.id]??0)>=1)continue;
      const actions:Action[]=[];
      if(b.sealed)actions.push({type:'set_structure_status',args:{planetId:p.id,structureId:b.id,sealed:false}});
      if((p.priorities?.[b.type]??LABOR[b.type].priority)!==5)actions.push({type:'set_jobs',args:{planetId:p.id,structureType:b.type,priority:5}});
      let labor=free+(b.sealed?0:LABOR[b.type].jobs);
      for(const spare of p.structures.filter(x=>x.id!==b.id&&!x.sealed&&['hospital','resort','maintenance','drydock','refinery','solar_hub','agriculture'].includes(x.type)).sort((x,y)=>x.id.localeCompare(y.id))){if(labor>=LABOR[b.type].jobs)break;actions.unshift({type:'set_structure_status',args:{planetId:p.id,structureId:spare.id,sealed:true}});labor+=LABOR[spare.type].jobs;}
      if(actions.length&&labor>=LABOR[b.type].jobs)out.push(group('crisis',book.risk>0?0:2,120,actions,'fallback: release labor and restore required '+b.type));
    }
    // Employ otherwise stranded labor even when fixed national net targets were met.
    const type=p.trait==='fertile'?'farm':p.trait==='sunny'?'solar':'mine';
    const useful=type==='mine'||book.normalNet[type==='farm'?'food':'energy']<owned(s,a).length*SRAS.reservePerColony;
    if(useful&&free>=LABOR[type].jobs&&left>STRUCTURES[type].days+SRAS.investmentDays&&!queue.some(q=>q.structureType===type)){
      const used=p.structures.filter(b=>STRUCTURES[b.type].slot==='ground').length+queue.filter(q=>q.structureType&&STRUCTURES[q.structureType].slot==='ground').length;
      if(used<capacity(p,'ground'))out.push(group('economy',4,12,[{type:'build_structure',args:{planetId:p.id,structureType:type}}],'fallback: idle labor into trait-suited useful production'));
      else if(!queue.some(q=>q.kind==='expansion')&&(p.expansions?.ground??0)<2&&p.population>=((p.expansions?.ground??0)?12:8))out.push(group('economy',4,10,[{type:'expand_slots',args:{planetId:p.id,slot:'ground'}}],'fallback: expand for funded idle-labor production'));
    }
    if(free<1&&p.population>=populationCap(p,s.day)-1&&left>SRAS.populationRunway)for(const type of ['housing','habitat'] as const)if(!p.structures.some(b=>b.type===type)&&!queue.some(q=>q.structureType===type))out.push(group('economy',3,35,[{type:'build_structure',args:{planetId:p.id,structureType:type}}],'fallback: population ceiling prevents employment growth'));
  }
  return out;
}

export function responsibilityRules(s:GameState,a:string,m:SrasMemory):RuleGroup[] {
  const out:RuleGroup[]=[],social=responsibilityView(s,a),book=ledger(s,a),f=s.factions[a];
  if(!social)return out;
  const balanced=basics.every(k=>book.normalNet[k]>=0)&&book.risk===0;
  for(const e of emergencyView(s,a)?.events??[])if(e.target===a&&balanced)for(const d of e.demands.filter(d=>d.acceptedDay===undefined&&d.day<s.day))out.push(group('diplomacy',0,110,[{type:'accept_stop_extraction',args:{demandId:d.id}}],'exit subsidy under a feasible supervision agreement'));
  if(route(s,a)==='utopia')for(const c of social.concerns.filter(c=>c.closedDay===undefined&&c.target!==a)){
    if(social.aid.some(x=>x.actor===a&&x.target===c.target&&x.endedDay===undefined)||social.reforms.some(x=>x.actor===a&&x.target===c.target&&x.endedDay===undefined))continue;
    if(balanced&&basics.every(k=>f.resources[k]/1000>book.reserves[k]+social.rules.aid[k]+m.tasks.reduce((n,t)=>n+(t.reserve[k]??0),0)))out.push(group('diplomacy',1,90,[{type:'offer_aid',args:{factionId:c.target,concernId:c.id}}],'fund a dated rescue obligation; only actual delivery counts'));
    else out.push(group('diplomacy',1,80,[{type:'propose_reform',args:{factionId:c.target,concernId:c.id}}],'seek feasible peaceful responsibility; proposal is not completion'));
  }
  if(f.faith&&balanced)for(const h of owned(s,a))for(const p of h.planets.filter(p=>p.ownerId===a&&p.holyCandidate&&p.population>0))if(!f.faith.sites.some(x=>x.planetId===p.id&&x.consecratedDay!==undefined)&&!h.projects.some(q=>q.planetId===p.id&&q.kind==='consecrate'))out.push(group('diplomacy',1,70,[{type:'consecrate',args:{planetId:p.id}}],'operable owned holy site; meet existing religious responsibility'));
  // Default secular; lock-in is only proposed together with a concrete affordable
  // rescue task. It does not pretend that a proposal has already succeeded.
  const concern=social.concerns.find(c=>c.closedDay===undefined&&c.target!==a);
  if(route(s,a)==='secular'&&balanced&&remaining(s)>SRAS.civilizationRunway&&civilizationEligibility(s,a,'utopia').allowed&&concern&&!m.tasks.some(t=>t.expert==='defense'&&t.blockers.length)&&basics.every(k=>f.resources[k]/1000>book.reserves[k]+social.rules.aid[k]+m.tasks.reduce((n,t)=>n+(t.reserve[k]??0),0)))out.push(group('diplomacy',3,30,[{type:'establish_civilization',args:{civilization:'utopia',acknowledgePermanent:true}},{type:'offer_aid',args:{factionId:concern.target,concernId:concern.id}}],'qualified permanent route with a funded concrete rescue task; acceptance uncertain'));
  return out;
}
