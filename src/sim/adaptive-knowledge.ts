import type { Fleet, GameState } from '../shared/types.js';
import { controller } from '../shared/v4.js';
import { emergencyView } from '../shared/emergency.js';
import { responsibilityView } from '../shared/responsibility.js';
import { militarySystems, visibleSystems } from './intel.js';

export function scriptKnowledge(state: GameState, actor: string): GameState {
  const world=structuredClone(state), own=world.factions[actor];
  const local=visibleSystems(state,actor), military=militarySystems(state,actor);
  const fleets=new Map<string,{fleet:Fleet;day:number}>();
  const remember=(fleet:Fleet,day:number)=>{
    if(fleet.ownerId===actor||day<(fleets.get(fleet.id)?.day??-1))return;
    fleets.set(fleet.id,{day,fleet:{id:fleet.id,name:fleet.name,ownerId:fleet.ownerId,systemId:fleet.systemId,position:structuredClone(fleet.position),ships:structuredClone(fleet.ships),transit:structuredClone(fleet.transit),order:null}});
  };
  for(const system of state.systems) {
    if(military.has(system.id)) own.militaryIntel={...own.militaryIntel,[system.id]:{day:state.day,source:local.has(system.id)?'local':'lrs',ownerId:system.ownerId,controllerId:controller(system),base:structuredClone(system.base),fleets:state.fleets.filter(fleet=>fleet.systemId===system.id).map(fleet=>({...structuredClone(fleet),order:null}))}};
    if(local.has(system.id)&&own.surveyed.includes(system.id)) own.intel[system.id]={day:state.day,system:{...structuredClone(system),projects:system.projects.filter(project=>project.ownerId===actor)},fleets:state.fleets.filter(fleet=>fleet.systemId===system.id).map(fleet=>({...structuredClone(fleet),order:null}))};
  }
  for(const memory of [...Object.values(own.intel),...Object.values(own.militaryIntel??{})]) for(const fleet of memory.fleets) remember(fleet,memory.day);
  for(const record of Object.values(own.transitIntel??{})) remember(record.fleet,record.day);
  for(const [id,record] of fleets) {
    const latest=record.fleet.systemId ? [own.intel[record.fleet.systemId],own.militaryIntel?.[record.fleet.systemId]].filter(Boolean).sort((first,second)=>second!.day-first!.day)[0] : undefined;
    if(latest&&latest.day>record.day&&!latest.fleets.some(fleet=>fleet.id===id))fleets.delete(id);
  }
  world.fleets=[...state.fleets.filter(fleet=>fleet.ownerId===actor).map(fleet=>structuredClone(fleet)),...[...fleets.values()].map(record=>record.fleet)];
  world.systems=state.systems.map(system=>{
    const ownLand=system.ownerId===actor||controller(system)===actor;
    const memory=own.intel[system.id], scan=own.militaryIntel?.[system.id];
    const known=ownLand?structuredClone(system):memory&&own.surveyed.includes(system.id)?structuredClone(memory.system):{id:system.id,name:system.name,position:structuredClone(system.position),neighbors:[...system.neighbors],gates:structuredClone(system.gates),ownerId:null,base:null,planets:[],projects:[]};
    if(!ownLand&&scan&&scan.day>=(memory?.day??-1)){known.ownerId=scan.ownerId;known.controllerId=scan.controllerId;known.base=structuredClone(scan.base);}
    known.projects=structuredClone(system.projects.filter(project=>project.ownerId===actor));
    return known;
  });
  const publicSocial=responsibilityView(world,actor)!;
  const extraction=emergencyView(state,actor)!;
  for(const id of Object.keys(world.factions).filter(id=>id!==actor)) {
    const original=state.factions[id];
    world.factions[id]={id,name:original.name,color:original.color,homeSystemId:original.homeSystemId,resources:{energy:0,food:0,minerals:0,alloys:0},lastIncome:{energy:0,food:0,minerals:0,alloys:0},unity:6000,shortages:{energy:false,food:false,minerals:false},surveyed:[],intel:{},strategies:[],...(original.eliminatedDay!==undefined?{eliminatedDay:original.eliminatedDay}:{})};
    const contacted=Object.values(state.relations).some(relation=>relation.factions.includes(actor)&&relation.factions.includes(id)&&relation.status!=='unknown');
    if(contacted&&original.faith)world.factions[id].faith={name:original.faith.name,doctrine:original.faith.doctrine,establishedDay:original.faith.establishedDay,crisis:0,sites:original.faith.sites.filter(site=>site.main).map(site=>({main:true,planetId:site.planetId,lossKeys:[],recoveryKeys:[]})),lossWindow:0,lossUsed:0,pending:[],triggers:{}};
    const event=extraction.events.find(event=>event.target===id);
    if(event)world.factions[id].extraction={id:event.id,startedDay:event.startedDay,expiresDay:event.expiresDay,stoppedDay:event.stoppedDay,initialCrisis:0,initialUnity:0,ships:{},known:{[actor]:original.extraction!.known[actor]},demands:structuredClone(event.demands),reformId:event.reformId,fulfilledDay:event.fulfilledDay,qualifiedDays:0,responses:{},totalGrant:{energy:0,food:0,minerals:0}};
  }
  world.relations=Object.fromEntries(Object.entries(world.relations).filter(([,relation])=>relation.factions.includes(actor)));
  world.wars=world.wars?.filter(war=>war.factions.includes(actor));
  world.claims=world.claims?.filter(claim=>claim.factionId===actor);
  world.grievances=world.grievances?.filter(reason=>reason.actor===actor);
  world.conquests=world.conquests?.filter(preparation=>preparation.actor===actor);
  world.missions=world.missions?.filter(mission=>mission.hostId===actor||mission.religionId===actor);
  world.cessions=world.cessions?.filter(cession=>cession.to===actor||cession.from===actor);
  world.civilizationAwards=world.civilizationAwards?.filter(award=>award.actor===actor);
  if(world.social)world.social={...world.social,founders:publicSocial.founders,reports:Object.fromEntries(publicSocial.reports.map(report=>[report.target,report])),distress:world.social.distress[actor]?{[actor]:world.social.distress[actor]}:{},concerns:publicSocial.concerns,aid:world.social.aid.filter(aid=>aid.actor===actor||aid.target===actor),reforms:publicSocial.reforms};
  world.events=world.events.filter(event=>event.audience.includes(actor)&&event.day>=state.day-500).map(event=>({...event,details:event.type==='order'&&(event.details as {factionId?:string})?.factionId===actor?event.details:undefined}));
  for(const memory of Object.values(own.intel)) {memory.system.projects=memory.system.projects.filter(project=>project.ownerId===actor);for(const fleet of memory.fleets)if(fleet.ownerId!==actor)fleet.order=null;}
  delete own.scriptMemory;
  return world;
}
