import { ADAPTIVE, type ScriptMemory } from '../shared/adaptive.js';
import { controller } from '../shared/v4.js';
import { SHIPS } from '../shared/rules.js';
import { shipMaterials } from '../shared/industry.js';
import type { GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { accessiblePath } from './diplomacy.js';
import { fleetPower } from './math.js';
import { constructionView } from '../shared/construction.js';
import { canFight, relationship } from '../shared/diplomacy.js';
import { RULES } from '../shared/rules.js';
import type { Fleet } from '../shared/types.js';

export function travelDays(state:GameState,actor:string,fleet:Fleet,target:string) {
  if(fleet.withdrawal)return Infinity;
  const start=fleet.transit?.to??fleet.systemId;
  if(!start)return Infinity;
  const path=accessiblePath(state,actor,start,target);
  if(!path)return Infinity;
  const speed=Math.min(...fleet.ships.map(ship=>SHIPS[ship.type].speed));
  return (fleet.transit?.remainingDays??0)+path.length*(RULES.jumpDays+Math.ceil(Math.SQRT2*1000/speed/10)*10);
}

export function defenseOutlook(state:GameState,actor:string) {
  const known=new Map<string,{fleet:Fleet;day:number}>(),own=state.factions[actor];
  for(const snapshot of [...Object.values(own.intel),...Object.values(own.militaryIntel??{})])for(const fleet of snapshot.fleets)if(fleet.ownerId!==actor&&(!known.has(fleet.id)||known.get(fleet.id)!.day<snapshot.day))known.set(fleet.id,{fleet,day:snapshot.day});
  for(const fleet of state.fleets.filter(fleet=>fleet.ownerId!==actor&&fleet.systemId&&state.fleets.some(local=>local.ownerId===actor&&local.systemId===fleet.systemId)))known.set(fleet.id,{fleet,day:state.day});
  return state.systems.filter(system=>system.ownerId===actor&&system.planets.some(planet=>planet.ownerId===actor)).map(system=>{
    const threats=[...known.values()].filter(item=>canFight(relationship(state,actor,item.fleet.ownerId))).map(item=>({...item,arrival:travelDays(state,item.fleet.ownerId,item.fleet,system.id)})).filter(item=>item.arrival<=ADAPTIVE.safetyDays);
    const arrival=threats.length?Math.min(...threats.map(item=>item.arrival)):Infinity;
    const defenders=state.fleets.filter(fleet=>fleet.ownerId===actor&&(fleet.order?fleet.order.systemId===system.id:fleet.systemId===system.id)&&travelDays(state,actor,fleet,system.id)<=arrival);
    const paid=system.planets.filter(planet=>planet.ownerId===actor).flatMap(planet=>constructionView(state,system,planet).queues.filter(queue=>queue.slot==='ship').flatMap(queue=>queue.projects)).filter(project=>project.estimatedCompleteDay!==null&&project.estimatedCompleteDay<=state.day+arrival).reduce((sum,item)=>{const project=system.projects.find(project=>project.id===item.id)!;return sum+(project.shipType?SHIPS[project.shipType].power:0);},0);
    const expected=threats.reduce((sum,item)=>sum+fleetPower(item.fleet)*ADAPTIVE.militaryUncertainty,0),available=(system.base?.hull??0)+defenders.reduce((sum,fleet)=>sum+fleetPower(fleet),0)+paid;
    return {systemId:system.id,arrival:Number.isFinite(arrival)?arrival:null,expected,available,deficit:Math.max(0,expected-available),unknown:threats.some(item=>state.day-item.day>ADAPTIVE.intelDays),intelDays:threats.map(item=>item.day),paidPower:paid};
  });
}

export function defenseCandidates(state:GameState,actor:string):ScriptCandidate[] {
  return defenseOutlook(state,actor).filter(threat=>threat.deficit>0).flatMap(threat=>state.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId!==threat.systemId&&!fleet.order&&!fleet.transit&&!fleet.withdrawal).filter(fleet=>travelDays(state,actor,fleet,threat.systemId)<=(threat.arrival??ADAPTIVE.safetyDays)).map(fleet=>({id:'defend:'+fleet.id+':'+threat.systemId,label:'提前增援 '+threat.systemId,kind:'defend',target:threat.systemId,actions:[{type:'move_fleet',args:{fleetId:fleet.id,systemId:threat.systemId,x:null,y:null,targetFleetId:null}}],priority:3,value:Math.min(fleetPower(fleet),threat.deficit),risk:0,reason:'按可见敌舰、通行与到达日期比较留守及增援',evidenceDays:threat.intelDays,progress:JSON.stringify(threat),deadline:state.day+(threat.arrival??300),economic:false,exclusive:['fleet:'+fleet.id],fingerprint:JSON.stringify(threat),tasks:[{fleetId:fleet.id,role:'defend' as const,target:threat.systemId}]})));
}

export function campaignCandidates(state:GameState,actor:string,memory:ScriptMemory,candidates:ScriptCandidate[]) {
  const remaining=(state.config.maxRounds-state.round)*100,own=state.factions[actor];
  if(memory.campaign) {
    const target=state.systems.find(system=>system.id===memory.campaign!.target);
    const relation=Object.values(state.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(memory.campaign!.opponent));
    if(!target||target.ownerId===actor||state.factions[memory.campaign.opponent]?.eliminatedDay!==undefined||!relation||remaining<200) {
      delete memory.campaign;memory.goal=null;
    }
  }
  const choices=candidates.filter(candidate=>['war','claim','prepare'].includes(candidate.kind)).map(candidate=>{
    const system=state.systems.find(system=>system.id===candidate.target);
    const opponent=String(candidate.actions.find(action=>action.args.factionId)?.args.factionId??system?.ownerId??candidate.target);
    const targets=system?[system]:state.systems.filter(system=>system.ownerId===opponent&&system.neighbors.some(id=>state.systems.some(home=>home.id===id&&controller(home)===actor)));
    const target=targets.sort((first,second)=>second.planets.filter(planet=>planet.ownerId===opponent).length-first.planets.filter(planet=>planet.ownerId===opponent).length||first.id.localeCompare(second.id,'en'))[0];
    return {candidate,opponent,target};
  }).filter(item=>item.target).sort((first,second)=>second.candidate.value-first.candidate.value||first.candidate.id.localeCompare(second.candidate.id,'en'));
  const previous=memory.campaign,best=choices[0];
  if(best&&(!previous||best.opponent===previous.opponent||best.candidate.value>(memory.goal?.value??0)*ADAPTIVE.switchRatio)) {
    const intel=own.militaryIntel?.[best.target.id]??own.intel[best.target.id];
    const progress=JSON.stringify({owner:best.target.ownerId,controller:controller(best.target),fresh:!!intel&&state.day-intel.day<=ADAPTIVE.intelDays,military:intel?.fleets.map(fleet=>({id:fleet.id,systemId:fleet.systemId,ships:fleet.ships})),conquest:state.conquests?.filter(item=>item.actor===actor&&item.target===best.opponent).map(item=>({id:item.id,ready:state.day>=item.readyDay,endedDay:item.endedDay})),fleets:state.fleets.filter(fleet=>fleet.ownerId===actor).map(fleet=>({id:fleet.id,systemId:fleet.systemId,ships:fleet.ships.length}))});
    const stalled=previous?.progress===progress&&state.round-previous.lastProgressRound>=ADAPTIVE.stalledRounds;
    memory.campaign={opponent:best.opponent,target:best.target.id,stage:stalled?'investigate':previous?.opponent===best.opponent?previous.stage:'investigate',reserve:previous?.opponent===best.opponent?previous.reserve:{},progress,lastProgressRound:previous?.progress===progress?previous.lastProgressRound:state.round,blockers:stalled?['两轮无实际进展，重新检查情报、通行和军备']:[]};
  }
  const campaign=memory.campaign;
  if(!campaign)return candidates;
  const target=state.systems.find(system=>system.id===campaign.target)!;
  const relation=Object.values(state.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(campaign.opponent));
  const snapshot=own.militaryIntel?.[target.id]??own.intel[target.id];
  const fresh=snapshot!==undefined&&state.day-snapshot.day<=ADAPTIVE.intelDays;
  const defenders=new Map<string,number>();
  for(const id of [target.id,...target.neighbors]) {
    const known=own.militaryIntel?.[id]??own.intel[id];
    for(const fleet of known?.fleets??[])if(fleet.ownerId===campaign.opponent)defenders.set(fleet.id,fleetPower(fleet));
  }
  const expected=([...defenders.values()].reduce((sum,power)=>sum+power,0)+(target.base?.hull??0))*ADAPTIVE.attackRatio*ADAPTIVE.militaryUncertainty;
  const staging=state.systems.filter(system=>controller(system)===actor&&target.neighbors.includes(system.id)).sort((first,second)=>first.id.localeCompare(second.id,'en'))[0];
  const arrivalLimit=Math.min(ADAPTIVE.safetyDays,remaining-200);
  const defense=defenseOutlook(state,actor);
  const reserved=new Set(memory.tasks.filter(task=>['defend','hold','withdraw'].includes(task.role)).map(task=>task.fleetId));
  for(const threat of defense) {
    const local=state.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId===threat.systemId&&!fleet.order).sort((first,second)=>fleetPower(second)-fleetPower(first)||first.id.localeCompare(second.id));
    let retained=state.systems.find(system=>system.id===threat.systemId)?.base?.hull??0;
    for(const [index,fleet] of local.entries())if(retained<threat.expected||threat.systemId===own.homeSystemId&&index===0){reserved.add(fleet.id);retained+=fleetPower(fleet);}
  }
  const force=state.fleets.filter(fleet=>fleet.ownerId===actor&&!reserved.has(fleet.id)&&(!fleet.order||[target.id,staging?.id].includes(fleet.order.systemId))&&!!staging&&travelDays(state,actor,fleet,staging.id)<=arrivalLimit).reduce((sum,fleet)=>sum+fleetPower(fleet),0);
  const paidPower=state.systems.filter(system=>controller(system)===actor&&!defense.some(threat=>threat.systemId===system.id&&threat.expected>threat.available-threat.paidPower)).flatMap(system=>system.planets.filter(planet=>planet.ownerId===actor).flatMap(planet=>constructionView(state,system,planet).queues.filter(queue=>queue.slot==='ship').flatMap(queue=>queue.projects.map(item=>({system,planet,item}))))).reduce((sum,{system,planet,item})=>{
    const project=system.projects.find(project=>project.id===item.id)!;
    if(!project.shipType||item.estimatedCompleteDay===null||!staging)return sum;
    const fleet:Fleet={id:project.id,name:project.id,ownerId:actor,systemId:system.id,position:planet.position,transit:null,order:null,ships:[{id:project.id,type:project.shipType,hull:SHIPS[project.shipType].power}]};
    return item.estimatedCompleteDay-state.day+travelDays(state,actor,fleet,staging.id)<=arrivalLimit?sum+fleetPower(fleet):sum;
  },0);
  campaign.paidPower=paidPower;
  const materials=shipMaterials('destroyer'),additional=Math.ceil(Math.max(0,expected-force-paidPower)/SHIPS.destroyer.power);
  campaign.reserve=fresh?{minerals:additional*materials.minerals/1000,alloys:additional*(materials.alloys??0)/1000}:{};
  const conquest=state.conquests?.some(item=>item.actor===actor&&item.target===campaign.opponent&&item.endedDay===undefined);
  campaign.stage=relation?.status==='war'?(controller(target)===actor?'control':'attack'):!fresh?'recon':conquest?'assemble':'prepare';
  if(!fresh)campaign.blockers.push('目标军情未知或超过200日；正式进攻仍须新鲜军情');
  campaign.expectedDay=state.day+arrivalLimit+200;
  campaign.nextStep=!fresh?'刷新目标军情':additional>0?'补足可按期到达的军备':conquest?'集结并复核宣战条件':'比较宣称、征服准备及合法战争';
  campaign.completion='新鲜军情、1.3倍进攻战力、本土留守及目标控制后结算';
  campaign.value=best?.candidate.value??campaign.value??0;
  if(state.round-campaign.lastProgressRound>=ADAPTIVE.stalledRounds) {
    campaign.blockers.push('两轮无实际进展：重新比较继续、调整与退出');
    if(!staging||remaining<arrivalLimit+400||defense.some(threat=>threat.deficit>0)) {
      campaign.stage='exit';campaign.reserve={};campaign.nextStep='释放进攻预算，优先防御及其他可执行目标';
    }
  }
  const additions:ScriptCandidate[]=[];
  if(staging&&remaining>500&&campaign.stage!=='exit')for(const fleet of state.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId&&!fleet.order&&!fleet.transit&&!fleet.withdrawal&&fleet.systemId!==staging.id)) {
    if(reserved.has(fleet.id))continue;
    const path=accessiblePath(state,actor,fleet.systemId!,staging.id);
    if(!path)continue;
    const id='assemble:'+fleet.id+':'+staging.id;
    additions.push({id,label:'战前合法边境集结 '+staging.id,kind:'assemble',target:target.id,actions:[{type:'move_fleet',args:{fleetId:fleet.id,systemId:staging.id,x:null,y:null,targetFleetId:null}}],priority:0,value:ADAPTIVE.capacityValue/(1+path.length),risk:0,reason:'为已选战役集结；不重复改令，不消耗在建舰船预付款',evidenceDays:snapshot?[snapshot.day]:[],progress:campaign.progress,deadline:state.day+remaining,economic:false,exclusive:['fleet:'+fleet.id],fingerprint:campaign.progress,tasks:[{fleetId:fleet.id,role:'assemble',target:staging.id}]});
  }
  if(!staging)campaign.blockers.push('没有已知己方边境集结点');
  return [...candidates,...additions];
}
