import { ADAPTIVE, type ScriptMemory } from '../shared/adaptive.js';
import { controller } from '../shared/v4.js';
import { SHIPS } from '../shared/rules.js';
import { shipMaterials } from '../shared/industry.js';
import type { GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { accessiblePath } from './diplomacy.js';
import { fleetPower } from './math.js';

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
  const force=state.fleets.filter(fleet=>fleet.ownerId===actor).reduce((sum,fleet)=>sum+fleetPower(fleet),0);
  const materials=shipMaterials('destroyer'),additional=Math.ceil(Math.max(0,expected-force)/SHIPS.destroyer.power);
  campaign.reserve=fresh?{minerals:additional*materials.minerals/1000,alloys:additional*(materials.alloys??0)/1000}:{};
  const conquest=state.conquests?.some(item=>item.actor===actor&&item.target===campaign.opponent&&item.endedDay===undefined);
  campaign.stage=relation?.status==='war'?(controller(target)===actor?'control':'attack'):!fresh?'recon':conquest?'assemble':'prepare';
  if(!fresh)campaign.blockers.push('目标军情未知或超过200日；正式进攻仍须新鲜军情');
  const staging=state.systems.filter(system=>controller(system)===actor&&target.neighbors.includes(system.id)).sort((first,second)=>first.id.localeCompare(second.id,'en'))[0];
  const additions:ScriptCandidate[]=[];
  if(staging&&remaining>500)for(const fleet of state.fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId&&!fleet.order&&!fleet.transit&&!fleet.withdrawal&&fleet.systemId!==staging.id)) {
    if(fleet.systemId===own.homeSystemId&&state.fleets.filter(other=>other.ownerId===actor&&other.systemId===own.homeSystemId&&other.id!==fleet.id).length===0)continue;
    const path=accessiblePath(state,actor,fleet.systemId!,staging.id);
    if(!path)continue;
    const id='assemble:'+fleet.id+':'+staging.id;
    additions.push({id,label:'战前合法边境集结 '+staging.id,kind:'assemble',target:target.id,actions:[{type:'move_fleet',args:{fleetId:fleet.id,systemId:staging.id,x:null,y:null,targetFleetId:null}}],priority:0,value:ADAPTIVE.capacityValue/(1+path.length),risk:0,reason:'为已选战役集结；不重复改令，不消耗在建舰船预付款',evidenceDays:snapshot?[snapshot.day]:[],progress:campaign.progress,deadline:state.day+remaining,economic:false,exclusive:['fleet:'+fleet.id],fingerprint:campaign.progress,tasks:[{fleetId:fleet.id,role:'assemble',target:staging.id}]});
  }
  if(!staging)campaign.blockers.push('没有已知己方边境集结点');
  return [...candidates.filter(candidate=>!['war','prepare','claim'].includes(candidate.kind)||candidate.target===campaign.opponent||candidate.target===campaign.target),...additions];
}
