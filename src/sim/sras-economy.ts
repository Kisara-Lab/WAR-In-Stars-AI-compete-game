import { policyComparison } from '../shared/comparison.js';
import { policyWindow } from '../shared/civil.js';
import { route } from '../shared/civilization.js';
import { responsibilityView } from '../shared/responsibility.js';
import { constructionView } from '../shared/construction.js';
import { allocation, capacity, LABOR, populationCap, support, shipMaterials } from '../shared/industry.js';
import { STRUCTURES, SHIPS, RULES } from '../shared/rules.js';
import { SRAS, type SrasMemory } from '../shared/sras.js';
import type { GameState } from '../shared/types.js';
import { basics, buildingUseful, group, ledger, owned, remaining, staffed, type RuleGroup } from './sras-rules.js';
import {situation} from './sras-response.js';

export function economicRules(s:GameState,a:string,m:SrasMemory):RuleGroup[] {
  const result:RuleGroup[]=[],f=s.factions[a],book=ledger(s,a),left=remaining(s);
  const ctx=situation(s,a),urgent=ctx.flags.includes('core-capacity-lost')||ctx.flags.includes('survival-emergency');
  const colonies=owned(s,a).flatMap(x=>x.planets.filter(p=>p.ownerId===a));
  const unserviced=colonies.filter(p=>p.population>=SRAS.development.startupPopulation&&!p.structures.some(b=>['mine','farm','solar'].includes(b.type)&&!b.sealed)&&!s.systems.flatMap(x=>x.projects).some(q=>q.planetId===p.id&&q.structureType&&['mine','farm','solar'].includes(q.structureType)));
  const targets={minerals:Math.max(SRAS.development.minimumMineralNet,colonies.length*SRAS.development.mineralsPerColony),energy:colonies.length*SRAS.development.energyPerColony,food:colonies.length*SRAS.development.foodPerColony};
  const yards=colonies.filter(p=>p.structures.some(b=>b.type==='shipyard'&&!b.sealed));
  const pendingYards=owned(s,a).flatMap(x=>x.projects).filter(q=>q.structureType==='shipyard').length;
  const yardDemand=Math.max(1,Math.ceil(colonies.length/SRAS.development.coloniesPerShipyard));
  const saturated=yards.length>0&&yards.every(p=>s.systems.flatMap(x=>x.projects).some(q=>q.planetId===p.id&&q.kind==='ship'));
  const crisis=book.risk>0||Object.values(f.shortages).some(Boolean)||(f.welfare?.last?.fraction??1)<1;
  const add=(...args:Parameters<typeof group>)=>result.push(group(...args));
  const social=responsibilityView(s,a);
  if(crisis)for(const offer of social?.aid??[])if(offer.target===a&&offer.acceptedDay===undefined&&offer.endedDay===undefined&&offer.expiresDay>s.day)add('crisis',0,100,[{type:'accept_aid',args:{proposalId:offer.id}}],'available emergency aid');
  for(const offer of social?.reforms??[])if(offer.target===a&&offer.acceptedDay===undefined&&offer.endedDay===undefined&&offer.offerUntil>s.day&&basics.every(k=>book.normalNet[k]>=0))add('diplomacy',1,70,[{type:'accept_reform',args:{proposalId:offer.id}}],'normal supplies support reform');
  if(f.extraction&&f.extraction.stoppedDay===undefined&&f.extraction.startedDay<s.day&&(f.extraction.expiresDay-s.day<=SRAS.reserveDays||!crisis))add('diplomacy',0,90,[{type:'stop_extraction',args:{}}],'exit temporary subsidy before its deadline');
  if(f.faith?.dispute)add('diplomacy',1,60,[{type:'respond_dispute',args:{response:'reform',warId:null,systemId:null}}],'resolve current institutional dispute');
  if(policyWindow(s,a)!==null) {
    const options=policyComparison(s,a).filter(x=>x.allowed&&x.choice!=='utopia'&&x.choice!=='militarism');
    options.sort((x,y)=>(y.net.food+y.net.energy+y.net.minerals+Math.max(-10,y.effectiveUnityChange)*2)-(x.net.food+x.net.energy+x.net.minerals+Math.max(-10,x.effectiveUnityChange)*2)||x.choice.localeCompare(y.choice));
    if(options[0]&&options[0].choice!==f.policy?.choice)add('economy',2,60,[{type:'choose_policy',args:{policy:options[0].choice}}],'current operating policy; no permanent route commitment');
  }
  if(['secular','militarist'].includes(route(s,a))&&f.welfare&&(f.welfare.firstChoice||s.day>=f.welfare.selectedDay+360)) {
    const levels=['survival','basic','comfortable','utopian'] as const,index=levels.indexOf(f.welfare.choice as typeof levels[number]);
    if(crisis&&index>0)add('crisis',0,80,[{type:'set_welfare',args:{welfare:levels[index-1]}}],'reduce a currently unaffordable bill');
    else if(!crisis&&!ctx.war&&index>=0&&index<2&&left>SRAS.reserveDays)add('economy',4,10,[{type:'set_welfare',args:{welfare:levels[index+1]}}],'raise welfare only after normal-income and reserve checks');
  }
  for(const system of owned(s,a))for(const p of system.planets.filter(x=>x.ownerId===a).sort((x,y)=>x.id.localeCompare(y.id))) {
    const jobs=allocation({...p,operation:undefined},s.day),queue=system.projects.filter(q=>q.planetId===p.id);
    for(const type of [...new Set(p.structures.map(b=>b.type))].sort()) {
      const resource=type==='farm'?'food':type==='solar'?'energy':type==='mine'?'minerals':null;
      const desired=resource&&(book.net[resource]<0||book.deficits[resource]>0)?5:(type==='shipyard'&&ctx.war||type==='lrs'&&m.tasks.some(t=>t.stage==='recon'))?5:(p.priorities?.[type]??LABOR[type].priority);
      if((p.priorities?.[type]??LABOR[type].priority)!==desired)add(crisis?'crisis':'economy',crisis?0:3,50,[{type:'set_jobs',args:{planetId:p.id,structureType:type,priority:desired}}],'restore required production priority');
    }
    for(const b of p.structures) {
      if(b.sealed&&buildingUseful(s,a,p.id,b.type)&&(!crisis||basics.some(k=>STRUCTURES[b.type].output[k]>0&&book.net[k]<0)))add('economy',crisis?0:2,40,[{type:'set_structure_status',args:{planetId:p.id,structureId:b.id,sealed:false}}],'reuse paid capacity before ordering more');
      else if(!b.sealed&&crisis&&!basics.some(k=>STRUCTURES[b.type].output[k]>0&&(book.net[k]<0||book.deficits[k]>0))) {
        const seal={type:'set_structure_status',args:{planetId:p.id,structureId:b.id,sealed:true}};
        add('crisis',0,30,[seal],'shed nonessential operating load; preserve scarce-resource sources');
        for(const type of ['farm','solar','mine'] as const)if(type!==b.type&&p.structures.some(x=>x.type===type)&&jobs[p.structures.find(x=>x.type===type)!.id]<1&&(p.priorities?.[type]??LABOR[type].priority)!==5)add('crisis',0,35,[seal,{type:'set_jobs',args:{planetId:p.id,structureType:type,priority:5}}],'fixed recovery recipe: release jobs and restore essential production');
      }
    }
    for(const q of queue) {
      const estimate=constructionView(s,system,p).queues.flatMap(x=>x.projects).find(x=>x.id===q.id);
      if(q.kind==='ship'&&crisis&&!m.tasks.some(t=>t.expert==='defense'&&t.stage!=='exit')||estimate&&estimate.estimatedCompleteDay!==null&&estimate.estimatedCompleteDay>s.day+left)add('endgame',crisis?0:1,20,[{type:'cancel_order',args:{projectId:q.id}}],'refund only for concrete shortage or terminal deadline');
    }
    for(const type of Object.keys(STRUCTURES).sort() as (keyof typeof STRUCTURES)[]) {
      const rule=STRUCTURES[type];
      const danger=ctx.threats.find(t=>t.system===system.id);
      if(danger&&danger.arrival<rule.days&&(system.base?.hull??0)<danger.power)continue;
      if(left<=rule.days+SRAS.investmentDays||queue.some(q=>q.structureType===type)||p.structures.some(b=>b.type===type&&b.sealed)||!staffed(s,a,p.id,type)||!buildingUseful(s,a,p.id,type))continue;
      if(p.structures.filter(b=>b.type===type).length>=LABOR[type].limit)continue;
      const used=p.structures.filter(b=>STRUCTURES[b.type].slot===rule.slot).length+queue.filter(q=>q.structureType&&STRUCTURES[q.structureType].slot===rule.slot).length;
      if(used>=capacity(p,rule.slot))continue;
      let rank=0;
      if(type==='farm')rank=book.net.food<targets.food?70:0;
      if(type==='solar')rank=book.net.energy<targets.energy?65:0;
      if(type==='mine')rank=book.net.minerals<targets.minerals?60:0;
      const startup=unserviced.some(x=>x.id===p.id);
      if(startup&&type==='mine')rank=Math.max(rank,75);
      if(type==='foundry')rank=book.net.minerals>30&&(f.resources.alloys??0)<Math.max(300,yards.length*120)*1000?35:0;
      if(type==='shipyard')rank=yards.length+pendingYards<yardDemand&&(yards.length===0||saturated)&&!p.structures.some(b=>b.type==='shipyard')?25:0;
      if(type==='sanatorium'||type==='resort')rank=f.unity<8000&&book.economy.effectiveUnityChange<1?30:0;
      if(type==='housing'||type==='habitat')rank=p.population>=populationCap(p,s.day)-1?20:0;
      if(type==='hospital')rank=p.population<populationCap(p,s.day)-2&&p.population>=4?10:0;
      if(['lrs','drydock','maintenance','refinery','agriculture','solar_hub'].includes(type))rank=15;
      if(rank>0)add('economy',crisis&&rank>=65?0:startup||type==='mine'&&book.net.minerals<targets.minerals?2:3,rank,[{type:'build_structure',args:{planetId:p.id,structureType:type}}],startup?'phase development: start production on an unserviced colony':`phase development: ${type}; national net targets ${JSON.stringify(targets)}`);
    }
    if(p.population>=8&&left>1000&&p.population>p.structures.reduce((n,b)=>n+(jobs[b.id]??0)*LABOR[b.type].jobs,0))for(const slot of ['ground','orbital'] as const)if(p.structures.filter(b=>STRUCTURES[b.type].slot===slot).length>=capacity(p,slot)&&!queue.some(q=>q.kind==='expansion'))add('economy',4,5,[{type:'expand_slots',args:{planetId:p.id,slot}}],'additional slots only for staffed expansion');
    if(!crisis&&support({...p,operation:undefined},'shipyard',s.day)===1&&queue.filter(q=>q.kind==='ship').length<SRAS.shipQueue&&left>SHIPS.destroyer.days+100) {
      const slots=SRAS.shipQueue-queue.filter(q=>q.kind==='ship').length;
      // Offer the full open queue first, retaining a one-ship fallback if the
      // shared cash/maintenance ledger cannot fund the complete order.
      const deadline=ctx.threats.length?Math.min(...ctx.threats.map(t=>t.arrival)):Math.min(left-100,ctx.war?400:800);
      const options=(Object.keys(SHIPS) as (keyof typeof SHIPS)[]).filter(type=>SHIPS[type].days<=Math.max(100,deadline)).sort((x,y)=>SHIPS[y].power/SHIPS[y].days-SHIPS[x].power/SHIPS[x].days||SHIPS[x].minerals-SHIPS[y].minerals);
      for(const type of options)for(let count=slots;count>=1;count--){const price=shipMaterials(type);if(f.resources.minerals<price.minerals*count||(f.resources.alloys??0)<(price.alloys??0)*count)continue;add('defense',urgent||m.tasks.some(t=>t.expert==='defense'&&t.stage!=='exit'&&t.blockers.length)?0:4,20+count+SHIPS[type].power/SHIPS[type].days,[{type:'queue_ships',args:{planetId:p.id,shipType:type,count}}],'fill timely ship capacity; shared maintenance and funding checks');}
    }
  }
  if(!crisis&&left>RULES.colonizeDays+SRAS.investmentDays)for(const system of [...s.systems].sort((x,y)=>x.id.localeCompare(y.id))) {
    const border=system.neighbors.some(id=>owned(s,a).some(x=>x.id===id));
    if(border&&!f.surveyed.includes(system.id)&&!system.projects.some(q=>q.ownerId===a&&q.kind==='survey'))add('exploration',m.stage==='exploration'?2:4,30,[{type:'survey_system',args:{systemId:system.id}}],'remote exploration without fleet contact');
    if(unserviced.length<SRAS.development.maxUnservicedColonies&&border&&f.surveyed.includes(system.id)&&system.ownerId===null&&!system.projects.some(q=>q.kind==='base'))add('exploration',3,35,[{type:'build_starbase',args:{systemId:system.id}}],'expand after existing colonies have production');
    if(unserviced.length<SRAS.development.maxUnservicedColonies&&system.ownerId===a)for(const p of system.planets.filter(p=>!p.ownerId&&!system.projects.some(q=>q.planetId===p.id&&q.kind==='colonize')))add('exploration',3,40,[{type:'colonize_planet',args:{planetId:p.id}}],'populate after existing colonies have production');
  }
  return result;
}
