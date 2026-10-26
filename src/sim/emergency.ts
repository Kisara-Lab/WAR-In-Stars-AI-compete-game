import { emergencyRules, extractingAt, supportedAt, recoveryFraction, V54, emergencyView } from '../shared/emergency.js';
import type { Extraction } from '../shared/emergency.js';
import type { GameState, Resources, Action, Fleet, Ship } from '../shared/types.js';
import { RULES, SHIPS, units } from '../shared/rules.js';
import { INDUSTRY, support } from '../shared/industry.js';
import { route, welfareQuote, CIVILIZATION } from '../shared/civilization.js';
import { controller, occupied, activeWar, v4Event } from '../shared/v4.js';
import { relationship } from '../shared/diplomacy.js';
import { RESPONSIBILITY } from '../shared/responsibility.js';
import { enforceReform, liveReform } from './social.js';
import { settleWar } from './wars.js';
import { applyV4Action } from './v4-actions.js';
import { previewDraft } from './preview.js';
import { migrateGovernance } from './governance.js';
import type { FactionFactors, LocalOutput } from './local.js';

const keys=['energy','minerals','food'] as const;
const zero=():Resources=>({energy:0,minerals:0,food:0});
const ensure:(v:unknown,message:string)=>asserts v=(v,message)=>{if(!v)throw Error(message);};

/** Per-ship accounting follows local/transit maintenance rounding, regardless of fleet merges. */
export function shipMaintenance(state:GameState, fleet:Fleet, ship:Ship, day:number, multiplier=1) {
  const system=state.systems.find(s=>s.id===fleet.systemId);
  const discount=system&&controller(system)===fleet.ownerId&&!occupied(system)?1-INDUSTRY.fleetDiscount*Math.min(1,system.planets.reduce((n,p)=>n+support(p,'maintenance',day),0)):1;
  return {energy:units(SHIPS[ship.type].energy*.1*multiplier*discount),minerals:units(SHIPS[ship.type].upkeep*.1*multiplier*discount)};
}
const peacefulMultiplier=(state:GameState,actor:string)=>(route(state,actor)==='militarist'?CIVILIZATION.militaryMaintenance:1)*(state.factions[actor].policy?.choice==='exercises'?CIVILIZATION.exerciseMaintenance:1);

export function extractionReasons(state:GameState,actor:string) {
  if(!emergencyRules(state)||route(state,actor)!=='utopia')return [];
  return Object.entries(state.factions).flatMap(([target,f])=>{
    const e=f.extraction,d=e?.demands.find(d=>d.actor===actor);
    if(!e||!extractingAt(e,state.day)||e.known[actor]===undefined||!d||f.eliminatedDay!==undefined)return [];
    return [{id:e.id,target,usableDay:Math.max(Math.min(d.rejectedDay??d.deadline,d.deadline),relationship(state,actor,target)?.pactUntil??0),expiresDay:e.expiresDay,source:'停止什四税通牒遭拒或到期'}];
  });
}

export function stopExtraction(state:GameState,target:string,source:string) {
  const e=state.factions[target].extraction;
  ensure(e&&extractingAt(e,state.day),'没有仍在持续的什四税；停止不能刷新期限');
  e.stoppedDay=state.day;
  v4Event(state,'religion','停止什四税，转入受监督民生恢复，原截止日不变',[target,...Object.keys(e.known)],{eventId:e.id,source,stoppedDay:e.stoppedDay,expiresDay:e.expiresDay});
}

export function applyEmergency(state:GameState,actor:string,action:Action,ticket:string) {
  ensure(emergencyRules(state),'此工具需要5.4规则');
  const f=state.factions[actor],a=action.args;
  if(action.type==='activate_extraction') {
    ensure(route(state,actor)==='theocracy'&&f.faith,'只有永久国教可以启用什四税');
    ensure(!f.extraction,'每国每局一次：既有使用记录不能重置');
    const ships:Extraction['ships']={};
    for(const fleet of state.fleets.filter(fl=>fl.ownerId===actor))for(const ship of fleet.ships)ships[ship.id]=shipMaintenance(state,fleet,ship,state.day,peacefulMultiplier(state,actor));
    f.extraction={id:'extraction-'+ticket,startedDay:state.day,expiresDay:state.day+V54.duration,initialCrisis:f.faith.crisis,initialUnity:f.unity,ships,known:{},demands:[],qualifiedDays:0,responses:{},totalGrant:zero()};
    if(f.stableFaith)f.stableFaith.wholeTerm=false;
    discoverExtractions(state);
    v4Event(state,'religion','启用一次性什四税：无来源特殊托底1800日，治理质量最高0.50',[actor,...Object.keys(f.extraction.known)],{eventId:f.extraction.id,startedDay:state.day,expiresDay:f.extraction.expiresDay});
    return emergencyView(state,actor)!.own;
  }
  if(action.type==='stop_extraction'){ensure(f.extraction&&f.extraction.startedDay<state.day,'只能停止轮边界已经启用的征收；不能在同一批启用又停止');stopExtraction(state,actor,'主动停止');return emergencyView(state,actor)!.own;}
  if(action.type==='demand_stop_extraction') {
    const target=a.factionId as string,e=state.factions[target]?.extraction;
    ensure(route(state,actor)==='utopia'&&actor!==target&&e&&e.id===a.eventId&&e.known[actor]!==undefined&&extractingAt(e,state.day),'须乌托邦针对已知且仍持续的征收事件');
    ensure(!e.demands.some(d=>d.actor===actor),'同一事件已提出要求，重复要求不刷新期限');
    const demand={id:'demand-'+ticket,actor,day:state.day,deadline:state.day+V54.ultimatumDays};e.demands.push(demand);
    v4Event(state,'war','要求停止什四税，180日最后通牒',[actor,target],{eventId:e.id,demand});return demand;
  }
  const e=f.extraction,d=e?.demands.find(d=>d.id===a.demandId);
  ensure(e&&d&&extractingAt(e,state.day),'没有仍在持续的对应征收及停止要求');
  ensure(d.day<state.day,'只能回应先前已收到的停止要求');
  ensure(d.acceptedDay===undefined,'停止要求已经接受');
  if(action.type==='reject_stop_extraction') {
    ensure(d.rejectedDay===undefined,'已经拒绝；重复回应不刷新日期');d.rejectedDay=state.day;
    v4Event(state,'war','拒绝停止什四税，合法救援路径开放',[actor,d.actor],{eventId:e.id,demandId:d.id,day:state.day});return {rejected:true};
  }
  ensure(action.type==='accept_stop_extraction','未知什四税命令');
  const agreement=enforceReform(state,d.actor,actor,e.id);
  d.acceptedDay=state.day;
  // The protocol covers the event, not just the first intervening state.
  settleExtractionWars(state,actor,e.id);
  return {accepted:true,reformId:agreement.id,expiresDay:e.expiresDay};
}

export function settleExtractionWars(state:GameState,target:string,eventId:string,exceptWar?:string) {
  for(const war of state.wars??[])if(war.id!==exceptWar&&war.endedDay===undefined&&war.factions.includes(target)&&Object.values(war.humanitarianReasons??{}).includes(eventId))settleWar(state,war,false,'什四税已停止，归还临时占领并监督恢复');
}

export function discoverExtractions(state:GameState,settleProgress=false) {
  if(!emergencyRules(state))return;
  for(const [target,f] of Object.entries(state.factions)) {
    const e=f.extraction;if(!e)continue;
    for(const actor of Object.keys(state.factions))if(actor!==target&&e.known[actor]===undefined&&['peace','war'].includes(relationship(state,actor,target)?.status??'')&&activeWar(state,actor,target)?.type!=='contact'){
      e.known[actor]=state.day;
      v4Event(state,'religion','收到公开强制征收报告',[actor,target],{eventId:e.id,target,startedDay:e.startedDay,expiresDay:e.expiresDay,stoppedDay:e.stoppedDay,reportDay:state.day});
    }
    if(settleProgress&&e.lastProgressDay!==state.day&&e.stoppedDay!==undefined&&state.day>e.stoppedDay&&e.fulfilledDay===undefined){
      e.lastProgressDay=state.day;
      const w=f.welfare?.last;
      const ok=!!w&&w.reachablePopulation>0&&keys.every(k=>w.paid[k]>=w.deliverable[k])&&!Object.values(f.shortages).some(Boolean);
      e.qualifiedDays=ok?e.qualifiedDays+RULES.tickDays:0;
      if(e.qualifiedDays>=RESPONSIBILITY.reformSuccessDays){e.fulfilledDay=state.day;v4Event(state,'beacon','停止征收后连续360日合格，救援责任完成',[target,...Object.keys(e.known)],{eventId:e.id,qualifiedDays:e.qualifiedDays});}
    }
    if(state.day>=e.expiresDay&&e.endedDay===undefined){
      e.stoppedDay??=e.expiresDay;e.endedDay=e.expiresDay;
      v4Event(state,'religion','什四税1800日截止：所有特殊补助及社会保护结束',[target,...Object.keys(e.known)],{eventId:e.id,expiresDay:e.expiresDay});
    }
  }
}

/** Called once in main-thread economy, before welfare; grants are not opening processing inventory. */
export function settleExtractionGrant(state:GameState,actor:string,income:Resources,upkeep:Resources,outputs:LocalOutput[],factor:FactionFactors) {
  const e=state.factions[actor].extraction,start=state.day-RULES.tickDays;
  if(!emergencyRules(state)||!supportedAt(e,start)||!e)return;
  const extraction=extractingAt(e,start), eligible={...upkeep}, allShips=zero(),protectedShips=zero();
  for(const fleet of state.fleets.filter(fl=>fl.ownerId===actor))for(const ship of fleet.ships){
    const actual=shipMaintenance(state,fleet,ship,start,factor.warUpkeep??1), normal=shipMaintenance(state,fleet,ship,start,peacefulMultiplier(state,actor)), cap=e.ships[ship.id];
    for(const k of ['energy','minerals'] as const){allShips[k]+=actual[k];if(cap&&extraction)protectedShips[k]+=Math.min(actual[k],normal[k],cap[k]);}
  }
  for(const k of keys)eligible[k]=Math.max(0,eligible[k]-allShips[k]+protectedShips[k]);
  if(!extraction){
    // Recovery keeps civilian operating costs, including permanent slot infrastructure, only.
    eligible.energy=0;eligible.minerals=0;
    for(const detail of outputs.flatMap(o=>o.economicDetails).filter(d=>d.factionId===actor)){
      for(const op of detail.operations??[])if(!(V54.excludedRecoveryStructures as readonly string[]).includes(op.type)){eligible.energy+=op.energy;eligible.minerals+=op.minerals;}
      eligible.energy+=units((detail.infrastructure?.energy??0)*.1);eligible.minerals+=units((detail.infrastructure?.minerals??0)*.1);
    }
  }
  const quote=factor.welfareQuote??welfareQuote(state,actor,RULES.tickDays),fade=extraction?1:recoveryFraction(e,start),grant=zero(),normalProduction={...income},uncovered=zero();
  for(const k of keys){
    grant[k]=Math.round(Math.max(0,eligible[k]+quote.deliverable[k]*(extraction?1+V54.reserveFraction:1)-income[k])*fade);
    uncovered[k]=Math.max(0,upkeep[k]-eligible[k]);
    income[k]+=grant[k];e.totalGrant[k]+=grant[k];
  }
  e.last={day:state.day,mode:extraction?'extraction':'recovery',fade,normalProduction,eligible,welfare:{...quote.deliverable},grant,uncovered};
  v4Event(state,'economy','什四税特殊补助结算：与正常生产分列',[actor],{eventId:e.id,...structuredClone(e.last)});
}

export function applyExtractionRecovery(state:GameState) {
  if(!emergencyRules(state))return;
  for(const [actor,f] of Object.entries(state.factions)){
    const e=f.extraction;if(!e||!supportedAt(e,state.day-RULES.tickDays)||!f.faith)continue;
    const progress=Math.min(1,(state.day-e.startedDay)/V54.duration);
    const ceiling=Math.round((e.initialCrisis+(Math.min(V54.crisisTarget,e.initialCrisis)-e.initialCrisis)*progress)*1000)/1000;
    const floor=Math.round(Math.min(V54.unityTarget,e.initialUnity)+(V54.unityTarget-Math.min(V54.unityTarget,e.initialUnity))*progress);
    const before={crisis:f.faith.crisis,unity:f.unity};f.faith.crisis=Math.min(f.faith.crisis,ceiling);f.unity=Math.max(f.unity,floor);
    v4Event(state,'religion','特殊社会托底：普通结算后施加危机上限和凝聚力下限',[actor],{eventId:e.id,progress,ceiling,floor,before,after:{crisis:f.faith.crisis,unity:f.unity},delta:{crisis:f.faith.crisis-before.crisis,unity:f.unity-before.unity}});
  }
}

/** Only known-intel validator decides actionability. Never inspect hidden enemy power. */
export function extractionDuty(state:GameState,actor:string) {
  if(!emergencyRules(state)||route(state,actor)!=='utopia')return {ignored:false,details:[]};
  const details:{eventId:string;ignored:boolean;reason:string}[]=[];
  for(const [target,f] of Object.entries(state.factions)){
    const e=f.extraction;if(!e||e.known[actor]===undefined||f.eliminatedDay!==undefined)continue;
    const start=state.day-RULES.tickDays,known=Math.max(e.known[actor],state.factions[actor].civilization!.establishedDay);
    if(start<known||e.fulfilledDay!==undefined)continue;
    const response=e.responses[actor]??={bufferedDays:0},d=e.demands.find(d=>d.actor===actor);
    let ignored=false,reason='处于回应期';
    if(e.stoppedDay!==undefined&&e.stoppedDay<=start){
      const progressing=e.qualifiedDays>0;
      if(progressing&&response.bufferedDays<RESPONSIBILITY.supervisionBuffer){response.bufferedDays+=RULES.tickDays;reason='停止后实际恢复，监督缓冲';}
      else {ignored=true;reason='停止后尚未持续恢复或监督缓冲耗尽';}
    } else if(!d){ignored=start>=known+V54.requestDays;reason=ignored?'未在180日内提出停止要求':'等待提出要求';}
    else if(start>=Math.min(d.rejectedDay??d.deadline,d.deadline)){
      const war=activeWar(state,actor,target);
      const intervention=war&&war.humanitarianReasons?.[actor]===e.id;
      const progressing=intervention&&war.hadHostilities;
      if(progressing&&response.bufferedDays<RESPONSIBILITY.supervisionBuffer){response.bufferedDays+=RULES.tickDays;reason='救援已实际交火，行动缓冲';}
      else if(intervention){ignored=true;reason='空宣战或行动缓冲耗尽';}
      else {
        const actionable=state.systems.some(s=>{try{applyV4Action(previewDraft(state),actor,{type:'declare_war',args:{factionId:target,warType:'humanitarian',systemIds:[s.id],grievanceId:e.id,reason:'停止征收合法性'}},'extraction-preview',false,true);return true;}catch{return false;}});
        ignored=actionable;reason=actionable?'存在合法救援路径却未行动':'条约、既有战争或已知目标/通行条件阻碍，军事追责暂停';
      }
    }
    details.push({eventId:e.id,ignored,reason});
  }
  return {ignored:details.some(d=>d.ignored),details};
}

export function migrateEmergency(original:GameState) {
  if(original.result)throw Error('已结束比赛不能迁移继续运行');
  if(emergencyRules(original))return structuredClone(original);
  const state=migrateGovernance(original);state.rulesRevision='5.4';
  // Never delete a prior usage record, including an explicitly restored branch.
  v4Event(state,'religion','显式迁移5.4：不追补补助；保留什四税既有使用记录、资产和战争',Object.keys(state.factions),{from:original.rulesRevision,revision:'5.4',day:state.day});
  return state;
}
