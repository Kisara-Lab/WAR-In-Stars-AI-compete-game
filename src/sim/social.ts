import { emergencyRules, extractingAt, supportedAt } from '../shared/emergency.js';
import { extractionReasons, stopExtraction, discoverExtractions, extractionDuty } from './emergency.js';
import { RESPONSIBILITY as R, responsible, newResponsibility, responsibilityView } from '../shared/responsibility.js';
import type { Aid, Concern, Reform } from '../shared/responsibility.js';
import { route } from '../shared/civilization.js';
import { relationship } from '../shared/diplomacy.js';
import { V4, activeWar, controller, v4Event } from '../shared/v4.js';
import type { War } from '../shared/v4.js';
import type { Action, GameState, Resources } from '../shared/types.js';
import { RULES, units } from '../shared/rules.js';
import { applyV4Action } from './v4-actions.js';
import { previewDraft } from './preview.js';
import { settleWar } from './wars.js';
import { warReasons } from '../shared/escalation.js';
import { shortestPath, seedNumber } from './math.js';

const keys = ['energy','minerals','food'] as const;
const zero = ():Resources => ({energy:0,minerals:0,food:0});
const ensure: (condition:unknown,message:string)=>asserts condition = (condition,message)=>{if(!condition)throw Error(message);};
export function initializeSocial(state:GameState) {
  state.social ??= {startedDay:state.day,founders:[],reports:{},distress:{},concerns:[],aid:[],reforms:[]};
  for(const f of Object.values(state.factions)) f.responsibility ??= newResponsibility(state.day);
}

const concernFor=(state:GameState,actor:string,target:string,id:string)=>state.social?.concerns.find(c=>c.id===id&&c.target===target&&c.closedDay===undefined&&c.known[actor]!==undefined);
export function liveReform(state:GameState,target:string){return state.social?.reforms.find(r=>r.target===target&&r.acceptedDay!==undefined&&r.endedDay===undefined&&(r.expiresDay??0)>state.day&&r.breachedDay===undefined);}
export function rescueReasons(state:GameState,actor:string){
  if(!responsible(state)||route(state,actor)!=='utopia')return [];
  const reasons:{id:string;target:string;usableDay:number;expiresDay:number|null;source:string}[]=[];
  for(const c of state.social?.concerns??[])if(c.target!==actor&&c.closedDay===undefined&&c.known[actor]!==undefined&&!liveReform(state,c.target))reasons.push({id:c.id,target:c.target,usableDay:Math.max(c.known[actor]+R.responseDays,relationship(state,actor,c.target)?.pactUntil??0),expiresDay:null,source:'公开民生关注未解除'});
  for(const r of state.social?.reforms??[])if(r.actor===actor&&r.breachedDay!==undefined&&(r.breachExpiresDay??0)>state.day&&!liveReform(state,r.target))reasons.push({id:'breach-'+r.id,target:r.target,usableDay:relationship(state,actor,r.target)?.pactUntil??r.breachedDay,expiresDay:r.breachExpiresDay!,source:'改革协议违约'});
  return [...reasons,...extractionReasons(state,actor)];
}
function imposeWelfare(state:GameState,target:string){
  const f=state.factions[target],w=f.welfare!;
  if(['survival','basic'].includes(w.choice)){w.choice='comfortable';w.selectedDay=state.day;w.firstChoice=false;w.highestSince=null;w.history=[];v4Event(state,'beacon',`${f.name}按民生协议提升至均衡小康`,[target],{welfare:w.choice,day:state.day});}
}
export function enforceReform(state:GameState,actor:string,target:string,concernId:string,warId?:string,goalId?:string,offer?:Reform){
  const extraction=emergencyRules(state)?state.factions[target].extraction:undefined;
  const stopping=extraction?.id===concernId&&extractingAt(extraction,state.day);
  const existing=liveReform(state,target);
  if(stopping&&existing){stopExtraction(state,target,'接受停止协议');extraction!.reformId=existing.id;existing.extractionId=extraction!.id;return existing;}
  ensure(!existing,'目标已有有效改革协议');
  const r:Reform=offer??{id:`reform-${warId??state.day}-${actor}-${target}-${state.social!.reforms.length}`,actor,target,concernId,createdDay:state.day,offerUntil:state.day,history:[],qualifiedDays:0,failedDays:0};
  r.acceptedDay=state.day;r.expiresDay=state.day+R.reformDays;r.warId=warId;r.goalId=goalId;
  if(!offer)state.social!.reforms.push(r);
  if(stopping){stopExtraction(state,target,warId??'接受停止协议');extraction!.reformId=r.id;r.extractionId=extraction!.id;}
  imposeWelfare(state,target);
  // Negotiated reform during peace carries the same non-aggression term as surrender.
  const relation=relationship(state,actor,target);if(relation)relation.pactUntil=state.day+RULES.nonAggressionDays;
  v4Event(state,'war',`${state.factions[target].name}接受1080日改革协议，前180日恢复，待遇至少小康`,[actor,target],{reform:structuredClone(r)});
  return r;
}
function endAid(state:GameState,a:Aid,outcome:string){
  if(a.endedDay!==undefined)return;
  const refund={...a.remaining};for(const k of keys){state.factions[a.actor].resources[k]+=a.remaining[k];a.remaining[k]=0;}
  a.endedDay=state.day;a.outcome=outcome;
  v4Event(state,'beacon',`民生援助${outcome}，返还未使用托管`,[a.actor,a.target],{aidId:a.id,refund});
}
export function applySocialAction(state:GameState,actor:string,action:Action,ticket:string){
  ensure(responsible(state),'此工具需要5.2规则');
  const a=action.args,social=state.social!;
  if(action.type==='get_responsibilities')return {...responsibilityView(state,actor),paths:dutyPaths(state,actor),rescueReasons:rescueReasons(state,actor)};
  if(action.type==='offer_aid'||action.type==='propose_reform'){
    const target=a.factionId as string,c=concernFor(state,actor,target,a.concernId as string);
    ensure(route(state,actor)==='utopia'&&actor!==target&&state.factions[target]?.eliminatedDay===undefined&&c,'须乌托邦针对已知且未解除的民生关注');
    if(action.type==='offer_aid'){
      ensure(!social.aid.some(p=>p.actor===actor&&p.target===target&&p.endedDay===undefined),'对同一国家已有未结束援助');
      for(const k of keys)ensure(state.factions[actor].resources[k]>=units(R.aid[k]),'援助托管资源不足（含本轮预留）');
      const remaining=zero();for(const k of keys){remaining[k]=units(R.aid[k]);state.factions[actor].resources[k]-=remaining[k];}
      const aid:Aid={id:'aid-'+ticket,actor,target,concernId:c.id,createdDay:state.day,expiresDay:state.day+R.offerDays,remaining,spent:zero(),improvedDays:0};social.aid.push(aid);
      v4Event(state,'beacon','提出福利专用援助，资金进入托管',[actor,target],{aid});return aid;
    }
    ensure(!liveReform(state,target)&&!social.reforms.some(r=>r.actor===actor&&r.target===target&&r.acceptedDay===undefined&&r.endedDay===undefined&&r.offerUntil>state.day),'已有改革协议或未过期提案');
    const r:Reform={id:'reform-'+ticket,actor,target,concernId:c.id,createdDay:state.day,offerUntil:state.day+R.offerDays,history:[],qualifiedDays:0,failedDays:0};social.reforms.push(r);v4Event(state,'war','提出民生改革协议',[actor,target],{reform:r});return r;
  }
  if(action.type==='accept_aid'||action.type==='reject_aid'){
    const aid=social.aid.find(p=>p.id===a.proposalId&&p.target===actor&&p.endedDay===undefined&&p.acceptedDay===undefined&&p.expiresDay>state.day);
    ensure(aid&&aid.createdDay<state.day,'没有上一轮收到且仍有效的援助提案');
    if(action.type==='reject_aid'){endAid(state,aid,'被拒绝');return {rejected:true};}
    aid.acceptedDay=state.day;aid.expiresDay=state.day+R.aidDays;imposeWelfare(state,actor);
    v4Event(state,'beacon','接受福利专用援助及360日最低待遇承诺',[aid.actor,actor],{aid:structuredClone(aid)});return aid;
  }
  if(action.type==='accept_reform'){
    const war=(state.wars??[]).find(w=>w.id===a.proposalId&&w.endedDay===undefined&&w.factions.includes(actor));
    const source=war?.factions.find(id=>id!==actor);
    if(war&&source&&war.humanitarianReasons?.[source]){
      const agreement=enforceReform(state,source,actor,war.humanitarianReasons[source]);
      settleWar(state,war,false,'主动接受民生改革，协商停战');return agreement;
    }
  }
  const r=social.reforms.find(p=>p.id===a.proposalId&&p.target===actor&&p.endedDay===undefined&&p.acceptedDay===undefined&&p.offerUntil>state.day);
  ensure(r&&r.createdDay<state.day,'没有上一轮收到且仍有效的改革提案');
  if(action.type==='reject_reform'){r.endedDay=state.day;v4Event(state,'war','拒绝民生改革提案',[r.actor,actor],{reformId:r.id});return {rejected:true};}
  enforceReform(state,r.actor,actor,r.concernId,undefined,undefined,r);
  const war=activeWar(state,r.actor,actor);if(war)settleWar(state,war,false,'接受改革协议，协商停战');
  return r;
}

/** Welfare escrow never enters the recipient's general inventory or processing budget. */
export function aidedWelfare(state:GameState,actor:string,available:Resources,due:Resources){
  const grants=(state.social?.aid??[]).filter(a=>a.target===actor&&a.acceptedDay!==undefined&&a.acceptedDay<state.day&&a.endedDay===undefined&&a.expiresDay>=state.day).sort((a,b)=>a.id.localeCompare(b.id));
  const total=zero();for(const k of keys)total[k]=available[k]+grants.reduce((n,a)=>n+a.remaining[k],0);
  const ratio=Math.min(1,...keys.map(k=>due[k]?total[k]/due[k]:1));
  const paid=zero(),selfPaid=zero(),aidPaid=zero();
  for(const k of keys){paid[k]=Math.floor(due[k]*ratio);selfPaid[k]=Math.min(available[k],paid[k]);let need=paid[k]-selfPaid[k];for(const a of grants){const value=Math.min(need,a.remaining[k]);a.remaining[k]-=value;a.spent[k]+=value;aidPaid[k]+=value;need-=value;}}
  if(keys.some(k=>aidPaid[k]))v4Event(state,'beacon','福利缺口由托管援助实际支付',[actor,...grants.map(a=>a.actor)],{target:actor,aidPaid,aidIds:grants.map(a=>a.id)});
  return {paid,selfPaid,aidPaid};
}

/** Ignore money and combat strength; validate only known legal paths on a private draft. */
export function dutyPaths(state:GameState,actor:string){
  if(!responsible(state))return {actionable:false,blocked:[] as string[],targets:[] as string[]};
  const kind=route(state,actor),active=(state.wars??[]).filter(w=>w.type!=='contact'&&w.endedDay===undefined&&w.factions.includes(actor));
  if(active.some(w=>kind==='militarist'||kind==='theocracy'&&w.attackers.includes(actor)&&w.goals[actor].some(g=>g.type==='missionary'&&!g.invalid)))return {actionable:true,blocked:[],targets:active.flatMap(w=>w.factions.filter(f=>f!==actor))};
  const targets:string[]=[],blocked:string[]=[];
  const draft=previewDraft(state);draft.factions[actor].resources={energy:1e12,minerals:1e12,food:1e12,alloys:1e12};draft.factions[actor].unity=10000;
  const valid=(action:Action)=>{try{applyV4Action(draft,actor,action,'duty-preview',false,true);return true;}catch{return false;}};
  for(const rel of Object.values(state.relations).filter(r=>r.factions.includes(actor)&&r.status==='peace')){
    const target=rel.factions.find(id=>id!==actor)!;if(state.factions[target].eliminatedDay!==undefined)continue;
    if(kind==='militarist'&&valid({type:'prepare_conquest',args:{factionId:target,reason:'职责合法路径'}})){targets.push(target);continue;}
    if(kind==='militarist'&&(state.conquests??[]).some(c=>c.actor===actor&&c.target===target&&c.endedDay===undefined)){targets.push(target);continue;}
    if(kind==='militarist'&&warReasons(state,actor).some(r=>r.target===target&&r.usable&&valid({type:'declare_war',args:{factionId:target,warType:'total',systemIds:[],grievanceId:r.id,reason:'职责合法路径'}}))){targets.push(target);continue;}
    for(const system of state.systems){
      const knownOwner=state.factions[actor].militaryIntel?.[system.id]?.ownerId??state.factions[actor].intel[system.id]?.system.ownerId;
      if(kind==='militarist'&&knownOwner===target&&valid({type:'create_claim',args:{systemId:system.id}})){targets.push(target);break;}
      const warType=kind==='theocracy'?'missionary':'limited';
      if(valid({type:'declare_war',args:{factionId:target,warType,systemIds:[system.id],grievanceId:null,reason:'职责合法路径'}})){targets.push(target);break;}
    }
    if(!targets.includes(target))blocked.push(`${target}：没有当前情报确认且满足条约/目标/通行条件的路径`);
  }
  return {actionable:targets.length>0,targets:[...new Set(targets)].sort(),blocked:targets.length?blocked:blocked.length?blocked:['没有正式接触且可行动的外国']};
}

export function onWarResponsibility(state:GameState,war:War,achieved:Set<string>){
  if(!responsible(state)||war.type==='contact')return;initializeSocial(state);
  for(const actor of war.factions){const f=state.factions[actor],d=f.responsibility!;if(d.awardedWars.includes(war.id))continue;
    const target=war.factions.find(id=>id!==actor)!;
    if(f.annexationProgress?.wars[war.id]) f.annexationProgress.wars[war.id].remaining=0;
    const lostInThisWar=(state.cessions??[]).some(c=>c.warId===war.id&&c.from===actor&&(war.openingTerritories?.[actor]??[]).includes(c.systemId)&&state.systems.find(s=>s.id===c.systemId)?.ownerId!==actor);
    const defended=!war.attackers.includes(actor)&&war.hadHostilities&&!achieved.has(target)&&!lostInThisWar;
    const missions=(state.missions??[]).filter(m=>m.warId===war.id&&m.religionId===actor&&m.expiresDay>state.day);
    if(route(state,actor)==='theocracy'&&missions.length){d.missionIds.push(...missions.map(m=>m.id));d.satisfiedUntil=state.day+R.achievementDays;d.overdueDays=0;d.awardedWars.push(war.id);}
    if(route(state,actor)==='militarist'){
      if(achieved.has(actor)||defended){d.dissatisfaction=0;d.overdueDays=0;d.satisfiedUntil=state.day+R.achievementDays;}
      else if(war.attackers.includes(actor))d.dissatisfaction=Math.min(100,d.dissatisfaction+R.militaryFailure);
      d.awardedWars.push(war.id);
    }
    v4Event(state,'war','战争成果与文明责任结算',[actor],{warId:war.id,achieved:achieved.has(actor),defended,missionIds:missions.map(m=>m.id),responsibility:structuredClone(d)});
  }
}

export function breach(state:GameState,r:Reform,reason:string){
  if(r.breachedDay!==undefined)return;
  r.breachedDay=state.day;r.breachExpiresDay=Math.max(state.day,relationship(state,r.actor,r.target)?.pactUntil??0)+R.breachReasonDays;
  v4Event(state,'war','民生改革协议违约：'+reason,[r.actor,r.target],{reformId:r.id,breachExpiresDay:r.breachExpiresDay,pactUntil:relationship(state,r.actor,r.target)?.pactUntil});
}
function fulfilled(state:GameState,actor:string,concernId:string,source:string){const d=state.factions[actor].responsibility!;const c=state.social!.concerns.find(c=>c.id===concernId);d.responses[concernId]??={knownDay:c?.known[actor]??state.day,bufferedDays:0};if(!d.responses[concernId].fulfilled){d.responses[concernId].fulfilled=true;v4Event(state,'beacon','已实际履行民生救援责任',[actor],{concernId,source});}}

export function updateSocial(state:GameState){
  if(!responsible(state))return;initializeSocial(state);const social=state.social!,dt=RULES.tickDays,start=state.day-dt;
  discoverExtractions(state,true);
  for(const [actor,f] of Object.entries(state.factions)){
    if(f.eliminatedDay!==undefined)continue;
    const w=f.welfare?.last;if(!w)continue;
    const reachable=w.reachablePopulation>0, fraction=reachable?Math.min(...keys.map(k=>w.deliverable[k]?w.paid[k]/w.deliverable[k]:1)):1;
    const low=['basic','survival'].includes(f.welfare!.choice),supplied=!Object.values(f.shortages).some(Boolean);
    const track=social.distress[actor]??={days:0,lowDays:0,unpaidDays:0,samples:[]};
    track.lowDays=reachable&&low?track.lowDays+dt:0;track.unpaidDays=reachable&&fraction<.9?track.unpaidDays+dt:0;track.days=Math.max(track.lowDays,track.unpaidDays);
    track.samples.push({day:state.day,fraction});track.samples=track.samples.filter(x=>x.day>state.day-R.reportDays);
    if(state.day%R.reportDays===0){const mean=track.samples.reduce((n,x)=>n+x.fraction,0)/track.samples.length;social.reports[actor]={target:actor,day:state.day,welfare:f.welfare!.choice,delivery:mean>=.9?'at_least_90':mean>=.5?'50_to_90':'below_50',distressed:track.days>=R.concernDays};}
    let c=social.concerns.find(c=>c.target===actor&&c.closedDay===undefined);
    if(!c&&track.days>=R.concernDays&&state.day%R.reportDays===0){c={id:`concern-${actor}-${state.day}`,target:actor,openedDay:state.day,known:{},clearDays:0};social.concerns.push(c);}
    if(c){
      c.clearDays=reachable&&!low&&fraction>=.9?c.clearDays+dt:0;
      if(c.clearDays>=R.concernDays){c.closedDay=state.day;v4Event(state,'beacon','民生关注因持续改善解除',[actor,...Object.keys(c.known)],{concernId:c.id});}
      else if(state.day%R.reportDays===0)for(const [other,of] of Object.entries(state.factions))if(other!==actor&&of.eliminatedDay===undefined&&['peace','war'].includes(relationship(state,actor,other)?.status??'')&&c.known[other]===undefined){c.known[other]=state.day;v4Event(state,'beacon','收到公开民生关注报告',[other,actor],{concernId:c.id,report:social.reports[actor],responseDay:state.day+R.responseDays});}
    }
    for(const a of social.aid.filter(a=>a.target===actor&&a.acceptedDay!==undefined&&a.endedDay===undefined)){
      a.improvedDays=reachable&&!low&&fraction>=.9&&keys.some(k=>a.spent[k]>0)?a.improvedDays+dt:0;
      if(a.improvedDays>=R.aidProgressDays)a.effective=true;
      const concern=social.concerns.find(c=>c.id===a.concernId);if(a.effective&&concern?.closedDay!==undefined)fulfilled(state,a.actor,a.concernId,a.id);
    }
    for(const r of social.reforms.filter(r=>r.target===actor&&r.acceptedDay!==undefined&&r.endedDay===undefined)){
      if(low)breach(state,r,'主动采用低于小康的待遇');
      const qualified=reachable&&!low&&fraction>=1&&supplied;
      r.history.push({day:state.day,qualified});r.history=r.history.filter(h=>h.day>state.day-R.reformWindow);
      r.qualifiedDays=qualified?r.qualifiedDays+dt:0;
      if(start>=r.acceptedDay!+R.reformRecoveryDays){
        const passed=r.history.length>=R.reformWindow/dt&&r.history.filter(h=>h.qualified).length/r.history.length>=R.reformFraction;
        r.failedDays=r.history.length>=R.reformWindow/dt&&!passed?r.failedDays+dt:0;
        if(r.failedDays>=R.reformFailureDays)breach(state,r,'滚动360日兑现未达90%，持续100日');
      }
      if(r.qualifiedDays>=R.reformSuccessDays&&r.breachedDay===undefined){r.effective=true;fulfilled(state,r.actor,r.concernId,r.id);}
      if((r.expiresDay??0)<=state.day){r.endedDay=state.day;v4Event(state,'war','民生改革监督期结束',[r.actor,r.target],{reform:structuredClone(r)});}
    }
  }
  for(const a of social.aid)if(a.endedDay===undefined&&(a.expiresDay<=state.day||state.factions[a.target].eliminatedDay!==undefined))endAid(state,a,a.acceptedDay===undefined?'提案到期':'援助结束');
  for(const r of social.reforms)if(r.acceptedDay===undefined&&r.endedDay===undefined&&r.offerUntil<=state.day){r.endedDay=state.day;v4Event(state,'war','改革提案到期',[r.actor,r.target],{reformId:r.id});}
  for(const [actor,f] of Object.entries(state.factions)){
    if(f.eliminatedDay!==undefined)continue;const d=f.responsibility!,kind=route(state,actor);
    if(kind==='theocracy'||kind==='militarist'){
      const grace=kind==='theocracy'?R.religiousGrace:R.militaryGrace,paths=dutyPaths(state,actor);
      const hasMission=(state.missions??[]).some(m=>d.missionIds.includes(m.id)&&m.expiresDay>start);
      if(kind==='theocracy'&&d.satisfiedUntil>start&&!hasMission){d.satisfiedUntil=start;v4Event(state,'religion','传教成果的有效权利已全部结束，责任满足窗口提前终止',[actor],{day:start,missionIds:d.missionIds});}
      const satisfied=start<d.satisfiedUntil;
      const active=(state.wars??[]).filter(w=>w.type!=='contact'&&w.endedDay===undefined&&w.hadHostilities&&w.factions.includes(actor)&&(kind==='militarist'||w.attackers.includes(actor)&&w.goals[actor].some(g=>g.type==='missionary'&&!g.invalid))).sort((a,b)=>a.id.localeCompare(b.id));
      const buffered=active.find(w=>(d.bufferedWars[w.id]??0)<R.battleBuffer);
      let pressure=0;const due=start>=d.startedDay+grace&&!satisfied&&paths.actionable&&!(emergencyRules(state)&&kind==='theocracy'&&supportedAt(f.extraction,start));
      const phaseBuffer = Object.entries(f.annexationProgress?.wars ?? {}).sort(([a],[b])=>a.localeCompare(b)).find(([id,b])=>b.remaining>0 && state.wars?.some(w=>w.id===id&&w.endedDay===undefined));
      if(due&&phaseBuffer)phaseBuffer[1].remaining=Math.max(0,phaseBuffer[1].remaining-dt);
      else if(due&&buffered)d.bufferedWars[buffered.id]=(d.bufferedWars[buffered.id]??0)+dt;
      else if(due){pressure=(kind==='theocracy'?(d.overdueDays>=R.religiousEscalationDays?R.religiousEscalatedPressure:R.religiousPressure):R.militaryPressure)*dt/100;d.overdueDays+=dt;
        if(kind==='theocracy')f.faith!.pending.push({reason:'未履行对外传教责任',amount:pressure,source:`duty:${state.day}`});else d.dissatisfaction=Math.min(100,d.dissatisfaction+pressure);
      }
      d.last={day:state.day,actionable:paths.actionable,blocked:paths.blocked,buffer:due&&(!!buffered||!!phaseBuffer),pressure};
    }
    if(kind==='utopia'){
      let ignored=false, covered=false;
      for(const c of social.concerns.filter(c=>c.target!==actor&&c.known[actor]!==undefined&&c.closedDay===undefined)){
        const extraction=emergencyRules(state)?state.factions[c.target].extraction:undefined;
        if(extraction&&extraction.known[actor]!==undefined&&(extractingAt(extraction,start)||extraction.fulfilledDay===undefined))continue;
        const response=d.responses[c.id]??={knownDay:Math.max(c.known[actor],f.civilization!.establishedDay),bufferedDays:0};
        if(response.fulfilled||start<response.knownDay+R.responseDays)continue;
        const progressing=social.aid.some(a=>a.actor===actor&&a.concernId===c.id&&a.effective&&a.endedDay===undefined)||social.reforms.some(r=>r.actor===actor&&r.concernId===c.id&&r.acceptedDay!==undefined&&r.endedDay===undefined&&r.breachedDay===undefined&&r.history.at(-1)?.qualified)||(state.wars??[]).some(w=>w.endedDay===undefined&&w.hadHostilities&&w.attackers.includes(actor)&&w.humanitarianReasons?.[actor]===c.id);
        if(progressing&&response.bufferedDays<R.supervisionBuffer){response.bufferedDays+=dt;covered=true;}else ignored=true;
      }
      // One genuinely progressing response covers concurrent concerns; proposals alone never do.
      const taxDuty=extractionDuty(state,actor);
      if(emergencyRules(state))d.extractionLast={day:state.day,details:taxDuty.details};
      ignored=ignored&&!covered||taxDuty.ignored;
      if(emergencyRules(state)&&taxDuty.details.length)v4Event(state,'beacon','停止征收责任判定',[actor],{day:state.day,...taxDuty});
      const changed=d.ignored!==ignored;d.ignored=ignored;
      if(ignored){delete d.recovery;d.rescuePenalty=Math.min(R.rescuePenaltyCap,d.rescuePenalty+R.rescuePenaltyPer100*dt/100);if(f.beacon){f.beacon.disqualified=true;f.beacon.streak=0;}}
      else if(d.rescuePenalty>0){d.recovery??={startedDay:start,amount:d.rescuePenalty};d.rescuePenalty=Math.max(0,d.recovery.amount*(1-(state.day-d.recovery.startedDay)/R.penaltyRecoveryDays));if(!d.rescuePenalty)delete d.recovery;}
      if(changed)v4Event(state,'beacon',ignored?'未履行救援责任，暂停灯塔并开始文明扣分':'救援责任改善，文明扣分开始恢复',[actor],{responsibility:structuredClone(d)});
    }
    if(kind!=='secular')v4Event(state,'beacon','文明责任十日明细',[actor],{day:state.day,route:kind,responsibility:structuredClone(d),...(f.annexationProgress?{annexationProgress:structuredClone(f.annexationProgress)}:{})});
  }
}
