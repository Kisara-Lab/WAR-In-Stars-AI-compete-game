import { ADAPTIVE_V41 as CONFIG, type CampaignV41 } from '../shared/adaptive-v41.js';
import type { MilitaryOptionV4, TacticalScenarioV4 } from '../shared/adaptive-v4.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import type { Action, Fleet, GameState } from '../shared/types.js';
import { activeWar, controller, type War, type WarType } from '../shared/v4.js';
import { SHIPS, RULES } from '../shared/rules.js';
import { ESCALATION, preparationRule } from '../shared/escalation.js';
import { relationKey, canFight } from '../shared/diplomacy.js';
import { scoreBreakdown } from '../shared/scoring.js';
import { governanceView } from '../shared/governance.js';
import { constructionView } from '../shared/construction.js';
import { accessiblePath } from './diplomacy.js';
import { distance, fleetPower } from './math.js';
import { economyFactors } from './engine.js';
import { processLocal, type FactionFactors } from './local.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { candidateFacts } from './adaptive-candidates.js';

export interface TacticalRequestV41 { actor:string; option:MilitaryOptionV4; }
export interface MilitaryCandidateV41 extends ScriptCandidate { military?:MilitaryOptionV4; }
const fleetScore=(fleets:Fleet[])=>fleets.flatMap(fleet=>fleet.ships).reduce((sum,ship)=>sum+SHIPS[ship.type].power*ESCALATION.fleetScoreFactor,0);
const move=(fleetId:string,systemId:string):Action=>({type:'move_fleet',args:{fleetId,systemId,x:500,y:500,targetFleetId:null}});

export function militaryKnowledge(state:GameState,actor:string) {
  const records=new Map<string,{fleet:Fleet;day:number}>();
  const own=state.factions[actor];
  for(const snapshot of [...Object.values(own.intel),...Object.values(own.militaryIntel??{})])for(const fleet of snapshot.fleets) {
    if(fleet.ownerId!==actor&&(!records.has(fleet.id)||records.get(fleet.id)!.day<snapshot.day))records.set(fleet.id,{fleet,day:snapshot.day});
  }
  for(const record of Object.values(own.transitIntel??{}))if(!records.has(record.fleet.id)||records.get(record.fleet.id)!.day<record.day)records.set(record.fleet.id,{fleet:record.fleet,day:record.day});
  for(const [id,record] of records) {
    const systemId=record.fleet.systemId;
    const newer=systemId?[own.intel[systemId],own.militaryIntel?.[systemId]].filter(Boolean).sort((first,second)=>second!.day-first!.day)[0]:undefined;
    if(newer&&newer.day>record.day&&!newer.fleets.some(fleet=>fleet.id===id))records.delete(id);
  }
  return [...records.values()].sort((first,second)=>first.fleet.id.localeCompare(second.fleet.id,'en'));
}

export function arrivalV41(state:GameState,actor:string,fleet:Fleet,target:string) {
  if(fleet.withdrawal||!fleet.ships.length)return Infinity;
  const start=fleet.transit?.to??fleet.systemId;
  if(!start)return Infinity;
  const path=accessiblePath(state,actor,start,target);
  if(!path)return Infinity;
  const speed=Math.min(...fleet.ships.map(ship=>SHIPS[ship.type].speed));
  let position=fleet.transit?state.systems.find(system=>system.id===start)?.gates[fleet.transit.from]:fleet.position;
  let current=start,days=fleet.transit?.remainingDays??0;
  for(const next of path) {
    const source=state.systems.find(system=>system.id===current)!;
    days+=Math.ceil(distance(position??{x:500,y:500},source.gates[next])/speed/10)*10+RULES.jumpDays;
    position=state.systems.find(system=>system.id===next)!.gates[current];current=next;
  }
  return days+Math.ceil(distance(position??{x:500,y:500},{x:500,y:500})/speed/10)*10;
}

export function cleanTasksV41(state:GameState,actor:string,memory:ScriptMemory) {
  memory.tasks=memory.tasks.filter(task=>{
    const fleet=state.fleets.find(fleet=>fleet.id===task.fleetId&&fleet.ownerId===actor);
    if(!fleet||task.expiresDay!==undefined&&task.expiresDay<=state.day)return false;
    if(task.warId&&!state.wars?.some(war=>war.id===task.warId&&war.endedDay===undefined))return false;
    if(task.role==='withdraw')return !!fleet.withdrawal||fleet.order?.systemId===task.target||fleet.transit?.to===task.target;
    if(task.role==='hold')return state.wars?.some(war=>war.endedDay===undefined&&war.goals[actor]?.some(goal=>goal.systemId===task.target&&!goal.invalid&&goal.heldDays<200))??false;
    if(task.role==='defend')return militaryKnowledge(state,actor).some(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&arrivalV41(state,record.fleet.ownerId,record.fleet,task.target)<=CONFIG.crisisDays);
    return !!memory.operation&&memory.operation.stage!=='exit'&&task.campaignId===memory.operation.id;
  });
}

export function scoreIntervalsV41(state:GameState,actor:string) {
  const result:Record<string,{low:number;high:number|null}>={[actor]:{low:scoreBreakdown(state,actor).total,high:scoreBreakdown(state,actor).total}};
  const records=militaryKnowledge(state,actor);
  for(const relation of Object.values(state.relations).filter(relation=>relation.factions.includes(actor)&&relation.status!=='unknown')) {
    const opponent=relation.factions.find(id=>id!==actor)!;
    result[opponent]={low:state.systems.filter(system=>system.ownerId===opponent).length*100+fleetScore(records.filter(record=>record.fleet.ownerId===opponent).map(record=>record.fleet)),high:null};
  }
  return result;
}

export function tacticalV41(state:GameState,request:TacticalRequestV41):MilitaryOptionV4 {
  const {actor}=request,option=structuredClone(request.option),opponent=option.opponent;
  const ownFactors=economyFactors(state)[actor];
  const records=militaryKnowledge(state,actor).filter(record=>record.fleet.ownerId===opponent);
  const originalFleets=state.fleets.filter(fleet=>fleet.ownerId===actor);
  const remaining=(state.config.maxRounds-state.round)*100;
  const assignedShips=new Set(originalFleets.filter(fleet=>option.fleetIds.includes(fleet.id)).flatMap(fleet=>fleet.ships.map(ship=>ship.id)));
  const ownInitial=fleetScore(originalFleets);
  const enemyInitial=fleetScore(records.map(record=>record.fleet));
  const scenarios:TacticalScenarioV4[]=[];
  for(const kind of ['hold','reinforce','counterattack'] as const) {
    const systems=structuredClone(state.systems).map(system=>({...system,projects:[]}));
    const relations=structuredClone(Object.fromEntries(Object.entries(state.relations).filter(([,relation])=>relation.factions.includes(actor)&&relation.factions.includes(opponent))));
    relations[relationKey(actor,opponent)]={...relations[relationKey(actor,opponent)],status:'war'};
    const probe={...state,systems,relations};
    const war:War={id:'v4-projection',factions:[actor,opponent],type:option.warType as WarType,startedDay:state.day,startedRound:state.round,attackers:[actor],reasons:{},goals:{[actor]:[],[opponent]:[]},fatigue:{[actor]:0,[opponent]:0},openingValue:{},lossWindow:0,lossUsed:{}};
    let fleets=structuredClone([...originalFleets,...records.map(record=>record.fleet)]);
    const factors:Record<string,FactionFactors>=Object.fromEntries(state.config.factionIds.map(id=>[id,id===actor?ownFactors:{unity:6000,shortages:{energy:false,food:false,minerals:false},civilizationCombat:1}]));
    const vulnerable=systems.filter(system=>system.ownerId===actor&&system.planets.some(planet=>planet.ownerId===actor)).sort((first,second)=>(first.base?.hull??0)+fleetPowerTotal(fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId===first.id&&!option.fleetIds.includes(fleet.id)))-(second.base?.hull??0)-fleetPowerTotal(fleets.filter(fleet=>fleet.ownerId===actor&&fleet.systemId===second.id&&!option.fleetIds.includes(fleet.id)))||first.id.localeCompare(second.id))[0];
    const issue=(fleet:Fleet,target:string)=>{
      const start=fleet.transit?.to??fleet.systemId;if(!start)return;
      const path=accessiblePath(probe,fleet.ownerId,start,target);if(!path)return;
      fleet.order={systemId:target,position:{x:500,y:500},targetFleetId:null,route:path};
    };
    let launched=option.mode==='defend';
    for(const fleet of fleets) {
      if(fleet.ownerId===actor&&option.fleetIds.includes(fleet.id))issue(fleet,option.mode==='defend'?option.target:option.staging??fleet.systemId??option.target);
      else if(fleet.ownerId===opponent&&(kind!=='hold'||option.mode==='defend'))issue(fleet,kind==='counterattack'&&option.mode!=='defend'&&fleet.systemId!==option.target&&vulnerable?vulnerable.id:option.target);
      else fleet.order=null;
    }
    let capturedDay:number|null=null,heldDays=0;
    const until=Math.min(remaining,option.arrival+CONFIG.tacticalDays);
    for(let elapsed=10;elapsed<=until;elapsed+=10) {
      const day=state.day+elapsed;
      const assigned=fleets.filter(fleet=>fleet.ownerId===actor&&fleet.ships.some(ship=>assignedShips.has(ship.id)));
      if(!launched&&day>=(option.availableDay??state.day)&&assigned.length&&assigned.every(fleet=>fleet.systemId===assigned[0].systemId&&!fleet.transit&&distance(fleet.position,assigned[0].position)<=20)) {
        const combined=assigned[0];combined.ships=assigned.flatMap(fleet=>fleet.ships);
        fleets=fleets.filter(fleet=>fleet===combined||!assigned.includes(fleet));issue(combined,option.target);launched=true;
      }
      for(const fleet of fleets) {
        delete fleet.previousPosition;delete fleet.departedDay;delete fleet.movementDays;
        if(!fleet.transit)continue;
        fleet.transit.remainingDays-=10;
        if(fleet.transit.remainingDays<=0) {
          const target=systems.find(system=>system.id===fleet.transit!.to)!;
          fleet.position={...target.gates[fleet.transit.from]};fleet.movementDays=Math.min(10,-fleet.transit.remainingDays);fleet.systemId=target.id;fleet.transit=null;
        }
      }
      for(const phase of ['advance','combat'] as const) {
        const output=processLocal({phase,seed:state.config.seed,day,systems,fleets,factions:factors,relations,wars:[war]});fleets=output.fleets;
      }
      const target=systems.find(system=>system.id===option.target)!;
      if(controller(target)===actor) {capturedDay??=day;heldDays+=10;}else{capturedDay=null;heldDays=0;}
    }
    const won=controller(systems.find(system=>system.id===option.target)!)===actor;
    const ownLoss=Math.max(0,ownInitial-fleetScore(fleets.filter(fleet=>fleet.ownerId===actor)));
    const enemyLoss=Math.max(0,enemyInitial-fleetScore(fleets.filter(fleet=>fleet.ownerId===opponent)));
    const exposedLoss=systems.filter(system=>state.systems.find(original=>original.id===system.id)!.ownerId===actor&&controller(system)!==actor).reduce((sum,system)=>sum+100+system.planets.filter(planet=>planet.population>0).reduce((value,planet)=>value+200+5*planet.population,0),0);
    const achieved=won&&(option.warType==='total'||heldDays>=200);
    const eliminated=systems.every(system=>system.ownerId!==actor);
    const value=eliminated?-scoreBreakdown(state,actor).total:enemyLoss-ownLoss-exposedLoss-option.maintenance+(achieved?option.territory+option.duty:0);
    scenarios.push({kind,won,ownLoss,enemyLoss,capturedDay,heldDays,exposedLoss,value});
  }
  option.scenarios=scenarios;
  const ordered=scenarios.map(scenario=>scenario.value).sort((first,second)=>first-second);
  const ownScore=scoreBreakdown(state,actor).total,lower=Math.max(0,...Object.values(scoreIntervalsV41(state,actor)).filter(item=>item.high===null).map(item=>item.low));
  const contest=ownScore<lower||remaining<=1440;
  option.value=contest?ordered[1]*.75+ordered[0]*.25:ordered[1]*.5+ordered[0]*.5;
  if(!scenarios.some(scenario=>scenario.won))option.blockers.push('已评估兵力方案无法取得目标，比较增援、侦察或退出');
  if(option.unknown)option.value*=CONFIG.preparationDiscount;
  return option;
}

const fleetPowerTotal=(fleets:Fleet[])=>fleets.reduce((sum,fleet)=>sum+fleetPower(fleet),0);

export function militaryPlansV41(state:GameState,actor:string,facts:ReturnType<typeof candidateFacts>,memory:ScriptMemory) {
  const own=state.factions[actor],remaining=(state.config.maxRounds-state.round)*100,records=militaryKnowledge(state,actor);
  const ownFleets=state.fleets.filter(fleet=>fleet.ownerId===actor&&!fleet.withdrawal);
  const plans:MilitaryOptionV4[]=[];
  for(const system of state.systems.filter(system=>system.ownerId===actor)) {
    const threats=records.filter(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&arrivalV41(state,record.fleet.ownerId,record.fleet,system.id)<=CONFIG.crisisDays);
    const occupier=controller(system)!==actor?controller(system):null;
    for(const opponent of [...new Set([...threats.map(record=>record.fleet.ownerId),...(occupier&&canFight(state.relations[relationKey(actor,occupier)])?[occupier]:[])])]) {
      const hostile=threats.filter(record=>record.fleet.ownerId===opponent),arrival=hostile.length?Math.min(...hostile.map(record=>arrivalV41(state,opponent,record.fleet,system.id))):0;
      const recapture=occupier===opponent;
      const knownPower=fleetPowerTotal(hostile.map(record=>record.fleet))+(recapture?system.base?.hull??0:0);
      const local=ownFleets.filter(fleet=>fleet.systemId===system.id&&!fleet.order);
      if(!recapture&&(system.base?.hull??0)+fleetPowerTotal(local)>=knownPower)continue;
      const available=ownFleets.filter(fleet=>!fleet.transit&&!fleet.withdrawal&&arrivalV41(state,actor,fleet,system.id)<=Math.max(arrival,recapture?CONFIG.tacticalDays:100));
      if(!available.length||!recapture&&!available.some(fleet=>fleet.systemId!==system.id))continue;
      plans.push({id:'defense:'+system.id+':'+opponent,opponent,target:system.id,warType:activeWar(state,actor,opponent)?.type??'contact',mode:'defend',fleetIds:available.map(fleet=>fleet.id),staging:system.id,arrival,expectedDay:state.day+arrival,knownPower,availablePower:fleetPowerTotal(available),unknown:hostile.some(record=>state.day-record.day>CONFIG.intelDays),intelDays:hostile.map(record=>record.day),scenarios:[],territory:100+system.planets.filter(planet=>planet.ownerId===actor).reduce((sum,planet)=>sum+200+5*planet.population,0),duty:0,maintenance:0,value:1000+knownPower,blockers:[],ready:true,preparation:false});
    }
  }
  for(const comparison of facts.facts.comparison.wars) {
    const opponent=comparison.target,war=activeWar(state,actor,opponent);
    const probe={...state,relations:{...state.relations,[relationKey(actor,opponent)]:{...state.relations[relationKey(actor,opponent)],status:'war' as const}}};
    for(const targetInfo of comparison.targetIntel??[]) {
      const target=state.systems.find(system=>system.id===targetInfo.systemId)!;
      if(controller(target)===actor)continue;
      if(war&&war.type!=='total'&&!war.goals[actor]?.some(goal=>!goal.invalid&&goal.systemId===target.id))continue;
      const intel=own.militaryIntel?.[target.id]??own.intel[target.id];
      const unknown=!intel||state.day-intel.day>CONFIG.intelDays;
      const legal=comparison.options.filter(option=>option.allowed&&(option.warType==='total'||option.systemIds.includes(target.id)));
      const preparation=!war&&!legal.some(option=>option.warType==='total')&&comparison.preparation.allowed;
      const pendingPreparation=state.conquests?.find(item=>item.actor===actor&&item.target===opponent&&item.endedDay===undefined);
      const newClaim=!war&&comparison.claims.some(claim=>claim.systemId===target.id&&claim.allowed&&!claim.existingClaim)&&!legal.some(option=>option.warType==='claim'&&option.systemIds.includes(target.id));
      const types=war?[{warType:war.type,systemIds:war.goals[actor]?.filter(goal=>!goal.invalid).map(goal=>goal.systemId)??[],grievanceId:null}]:[...legal,...(preparation||pendingPreparation&&!legal.some(option=>option.warType==='total')?[{warType:'total',systemIds:[],grievanceId:null}]:[]),...(newClaim?[{warType:'claim',systemIds:[target.id],grievanceId:null}]:[])];
      const reachable=ownFleets.filter(fleet=>!memory.tasks.some(task=>task.fleetId===fleet.id&&task.role==='hold')).map(fleet=>({fleet,days:arrivalV41(probe,actor,fleet,target.id)})).filter(item=>item.days<remaining-200).sort((first,second)=>first.days-second.days||first.fleet.id.localeCompare(second.fleet.id));
      if(!reachable.length)continue;
      const defending=records.filter(record=>record.fleet.ownerId===opponent&&record.fleet.systemId===target.id);
      const enemy=(target.base?.hull??0)+fleetPowerTotal(defending.map(record=>record.fleet));
      const limited:typeof reachable=[];let power=0;
      for(const item of reachable){limited.push(item);power+=fleetPower(item.fleet);if(power>enemy)break;}
      for(const mode of ['limited','concentrated'] as const) {
        const force=mode==='limited'?limited:reachable;
        const staging=state.systems.filter(system=>controller(system)===actor&&force.every(item=>Number.isFinite(arrivalV41(state,actor,item.fleet,system.id)))).sort((first,second)=>Math.max(...force.map(item=>arrivalV41(state,actor,item.fleet,first.id)))+arrivalV41(probe,actor,{...force[0].fleet,systemId:first.id,transit:null,position:{x:500,y:500}},target.id)-Math.max(...force.map(item=>arrivalV41(state,actor,item.fleet,second.id)))-arrivalV41(probe,actor,{...force[0].fleet,systemId:second.id,transit:null,position:{x:500,y:500}},target.id)||first.id.localeCompare(second.id))[0];
        const clustered=force.every(item=>item.fleet.systemId===force[0].fleet.systemId&&!item.fleet.transit&&distance(item.fleet.position,force[0].fleet.position)<=20);
        const ready=clustered&&force.length<=20;
        const gathered=ready?force[0].fleet.systemId:staging?.id;
        const slowest=force.flatMap(item=>item.fleet.ships).sort((first,second)=>SHIPS[first.type].speed-SHIPS[second.type].speed)[0];
        const gatherDays=ready?0:staging?Math.max(...force.map(item=>arrivalV41(state,actor,item.fleet,staging.id))):Infinity;
        const travelDays=gathered?arrivalV41(probe,actor,{...force[0].fleet,systemId:gathered,transit:null,position:ready?force[0].fleet.position:{x:500,y:500},ships:[slowest]},target.id):Infinity;
        for(const type of types) {
          const prep=type.warType==='total'&&preparation;
          const claim=type.warType==='claim'&&newClaim;
          const wait=prep?preparationRule(state,actor).days:type.warType==='total'&&pendingPreparation?Math.max(0,pendingPreparation.readyDay-state.day):claim?100:0;
          const arrival=Math.max(wait,gatherDays)+travelDays;
          const colonies=target.planets.filter(planet=>planet.ownerId===opponent);
          const social=colonies.reduce((sum,planet)=>sum+200+5*planet.population,0);
          const territory=['total','claim'].includes(type.warType)?100+social*.5+100:50;
          const duty=type.warType==='missionary'&&own.faith?Math.max(150,governanceView(state,actor).rawSocial*.25):type.warType==='humanitarian'&&own.civilization?.choice==='utopia'?Math.min(300,(own.responsibility?.rescuePenalty??0)+150):own.civilization?.choice==='militarist'?150:0;
          const maintenance=type.warType==='total'?(comparison.totalWarExtraPer100.energy+comparison.totalWarExtraPer100.minerals)*Math.min(remaining,arrival+600)/100*CONFIG.investmentValue:0;
          const id=['military',opponent,target.id,type.warType,mode].join(':');
          const blockers=[...(unknown?['目标军情未知或超过200日']:[]),...(!ready?['指定舰队尚未集中，先集结再协调进攻']:[]),...(prep?['尚需征服准备']:[])];
          plans.push({id,opponent,target:target.id,warType:type.warType,mode,fleetIds:force.map(item=>item.fleet.id),staging:gathered??null,arrival,expectedDay:state.day+arrival+200,knownPower:enemy,availablePower:fleetPowerTotal(force.map(item=>item.fleet)),unknown,intelDays:intel?[intel.day,...defending.map(record=>record.day)]:[],scenarios:[],territory,duty,maintenance,value:territory+duty+fleetScore(defending.map(record=>record.fleet))*.5-maintenance,blockers,ready,preparation:prep,claim,availableDay:state.day+wait});
        }
      }
    }
  }
  return plans.filter(plan=>plan.expectedDay<=state.day+remaining).sort((first,second)=>second.value-first.value||first.id.localeCompare(second.id));
}

export function militaryActionV41(state:GameState,actor:string,option:MilitaryOptionV4,facts:ReturnType<typeof candidateFacts>):MilitaryCandidateV41|null {
  if(option.value<=0)return null;
  const comparison=facts.facts.comparison.wars.find(war=>war.target===option.opponent)!;
  const war=activeWar(state,actor,option.opponent);
  const force=state.fleets.filter(fleet=>option.fleetIds.includes(fleet.id));
  if(!force.length)return null;
  if(war&&war.type!=='total'&&option.mode!=='defend'&&!war.goals[actor]?.some(goal=>!goal.invalid&&goal.systemId===option.target))return null;
  let kind='war',actions:Action[]=[];
  if(option.mode==='defend') {
    actions=force.filter(fleet=>!fleet.transit&&fleet.order?.systemId!==option.target&&(fleet.systemId!==option.target||distance(fleet.position,{x:500,y:500})>20)).map(fleet=>move(fleet.id,option.target));kind='defend';
  } else if(option.unknown) {
    const scout=force.filter(fleet=>!fleet.order&&!fleet.transit&&Number.isFinite(arrivalV41(state,actor,fleet,option.target))).sort((first,second)=>fleetPower(first)-fleetPower(second))[0];
    const target=state.systems.find(system=>system.id===option.target)!;
    if(!scout||canFight(state.relations[relationKey(actor,option.opponent)])&&(target.base||militaryKnowledge(state,actor).some(record=>record.fleet.systemId===target.id)))return null;
    actions=[move(scout.id,target.id)];kind='scout';
  } else if(option.claim) {
    actions=[{type:'create_claim',args:{systemId:option.target}}];kind='claim';
  } else if(option.preparation) {
    actions=[{type:'prepare_conquest',args:{factionId:option.opponent,reason:'V41比较实际战损、对手失分和可兑现目标后准备'}}];kind='prepare';
  } else if(!option.ready) {
    if(!option.staging)return null;
    const grouped=force.length>20&&force.every(fleet=>fleet.systemId===force[0].systemId&&!fleet.transit&&distance(fleet.position,force[0].position)<=20);
    actions=grouped?[{type:'merge_fleets',args:{fleetIds:force.slice(0,20).map(fleet=>fleet.id)}}]:force.filter(fleet=>!fleet.transit&&!fleet.order&&(fleet.systemId!==option.staging||distance(fleet.position,{x:500,y:500})>20)).map(fleet=>move(fleet.id,option.staging!));kind='assemble';
  } else {
    if((option.availableDay??state.day)>state.day)return null;
    const selected=comparison.options.find(item=>item.allowed&&item.warType===option.warType&&(item.warType==='total'||item.systemIds.includes(option.target)));
    if(!war&&!selected)return null;
    if(!war)actions.push({type:'declare_war',args:{factionId:option.opponent,warType:option.warType,systemIds:selected!.systemIds,grievanceId:selected!.grievanceId??null,reason:'V41局部战斗情景与争胜收益比较'}});
    if(force.length>1)actions.push({type:'merge_fleets',args:{fleetIds:force.map(fleet=>fleet.id)}});
    if(force[0]&&!(force.length===1&&(force[0].order?.systemId===option.target||force[0].transit?.to===option.target)))actions.push(move(force[0].id,option.target));
  }
  if(!actions.length)return null;
  return {id:option.id,label:kind+' '+option.opponent+'/'+option.target,kind,target:option.target,actions,priority:option.mode==='defend'?3:option.duty>0?2:1,value:option.value*(['war','defend'].includes(kind)?1:CONFIG.preparationDiscount),risk:0,reason:JSON.stringify(option),evidenceDays:option.intelDays,progress:option.id,deadline:option.expectedDay,economic:false,exclusive:[...(option.mode==='defend'?[]:['offensive-campaign']),...force.map(fleet=>'fleet:'+fleet.id)],fingerprint:option.id,tasks:force.map(fleet=>({fleetId:fleet.id,role:kind==='defend'?'defend':kind==='war'?'attack':'assemble',target:['war','defend'].includes(kind)?option.target:option.staging??option.target,campaignId:option.id,expiresDay:option.expectedDay+600,...(war?{warId:war.id}:{})})),successDay:option.expectedDay,military:option};
}

export function campaignProgressV41(state:GameState,actor:string,memory:ScriptMemory) {
  const operation=memory.operation as CampaignV41|undefined;if(!operation)return;
  const war=activeWar(state,actor,operation.opponent);
  const target=state.systems.find(system=>system.id===operation.targets[0]);
  const relation=state.relations[relationKey(actor,operation.opponent)];
  const lostGoal=war&&war.type!=='total'&&!war.goals[actor]?.some(goal=>!goal.invalid&&operation.targets.includes(goal.systemId));
  const complete=!!operation.warId&&!war;
  if(complete||!target||lostGoal||operation.deadline<state.day||!war&&(relation?.pactUntil??0)>state.day) {
    operation.stage='exit';operation.ready=false;operation.reserve={};operation.completed=!!complete;
    operation.exitReason=complete?'关联战争已结算':lostGoal?'目标不属于当前战争条款':'目标、条约或最迟出发日期失效';
    operation.nextStep=operation.exitReason;memory.tasks=memory.tasks.filter(t=>t.campaignId!==operation.id);return;
  }
  if(war)operation.warId=war.id;
  const ships=new Set(operation.shipIds??[]);
  const fleets=state.fleets.filter(f=>f.ownerId===actor&&(operation.fleetIds.includes(f.id)||f.ships.some(s=>ships.has(s.id))));
  operation.fleetIds=fleets.map(f=>f.id);operation.shipIds=fleets.flatMap(f=>f.ships.map(s=>s.id));
  const intel=state.factions[actor].militaryIntel?.[target.id]??state.factions[actor].intel[target.id];
  const destination=war?target.id:operation.staging??target.id;
  const next={destination,reconDay:intel&&state.day-intel.day<=CONFIG.intelDays?intel.day:-1,
    prepared:state.conquests?.some(c=>c.actor===actor&&c.target===operation.opponent&&c.endedDay===undefined&&c.readyDay<=state.day)??false,
    arrived:fleets.filter(f=>f.systemId===destination&&!f.transit&&distance(f.position,{x:500,y:500})<=20).map(f=>f.id).sort(),
    distance:fleets.reduce((n,f)=>n+Math.min(100000,arrivalV41(state,actor,f,destination)),0),
    held:Math.max(0,...war?.goals[actor]?.filter(g=>operation.targets.includes(g.systemId)).map(g=>g.heldDays)??[]),launched:!!war};
  const old=operation.milestones;
  const sameDestination=old?.destination===destination;
  const progressed=!old||next.reconDay>=0&&old.reconDay<0||next.prepared&&!old.prepared||next.launched&&!old.launched||next.held>old.held||next.arrived.some(id=>!old.arrived.includes(id))||sameDestination&&next.distance+10<old.distance;
  if(progressed)operation.lastProgressRound=state.round;
  // Keep the best distance/held milestone: oscillation never resets the clock.
  operation.milestones={...next,distance:old&&sameDestination?Math.min(old.distance,next.distance):next.distance,held:old?Math.max(old.held,next.held):next.held};
  operation.progress=JSON.stringify(operation.milestones);
  if(next.held>=200){operation.stage='settle';operation.nextStep='比较强制议和与继续作战的实际保留收益';}
  else if(next.held>0){operation.stage='control';operation.nextStep='保持声明目标控制至200日';}
  else if(war){operation.stage='attack';operation.nextStep='集中指定舰队进攻当前战争声明目标';}
  if(state.round-operation.lastProgressRound>=CONFIG.stalledRounds) {
    operation.lastAssessmentRound=state.round;operation.stage='exit';operation.reserve={};operation.ready=false;
    operation.exitReason='两轮无相关进展，释放旧分配，重新比较继续、调整与退出';operation.nextStep=operation.exitReason;
    memory.tasks=memory.tasks.filter(t=>t.campaignId!==operation.id);
  }
}
