import { ADAPTIVE_V4 as CONFIG, type RiskV4 } from '../shared/adaptive-v4.js';
import { policyComparison } from '../shared/comparison.js';
import { welfareQuote } from '../shared/civilization.js';
import { controller } from '../shared/v4.js';
import { STRUCTURES } from '../shared/rules.js';
import { industryPlanet } from '../shared/industry.js';
import { constructionView } from '../shared/construction.js';
import type { Action, GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { v3StaticTimeline, type V3Coverage } from './adaptive-v3-values.js';
import type { economicForecast } from './forecast.js';
import { militaryKnowledge, arrivalV4 } from './adaptive-v4-military.js';
import { canFight, relationKey } from '../shared/diplomacy.js';
import { fleetPower } from './math.js';
import { accessiblePath } from './diplomacy.js';
import { positionValueV4, surveyValueV4 } from './adaptive-v4-values.js';

export const emptyRiskV4=():RiskV4=>({shortageDays:0,shortageSeverity:0,unpaidDays:0,unpaidSeverity:0,lowUnityDays:0,recoveryDay:null,shortfall:{energy:0,food:0,minerals:0},value:0});
export function riskValueV4(risk:RiskV4) {
  return risk.shortageDays*CONFIG.shortageDayValue+ risk.shortageSeverity*CONFIG.shortageSeverityValue+ risk.unpaidSeverity*CONFIG.unpaidValue+Object.values(risk.shortfall).reduce((sum,value)=>sum+value,0)*CONFIG.investmentValue;
}
export function forecastRiskV4(forecast:ReturnType<typeof economicForecast>) {
  const risk=structuredClone(forecast.trajectory?.at(-1)?.risk??emptyRiskV4());
  risk.value=riskValueV4(risk);return risk;
}
export function currentRiskV4(state:GameState,actor:string,days=Math.min(CONFIG.crisisDays,(state.config.maxRounds-state.round)*100)) {
  const faction=state.factions[actor],quote=policyComparison(state,actor,[faction.policy?.choice??'none'])[0],bill=welfareQuote(state,actor,100);
  const risk=emptyRiskV4();
  for(const resource of ['energy','food','minerals'] as const) {
    const full=quote.upkeep[resource]-quote.welfarePaid[resource]+bill.deliverable[resource]/1000;
    const short=Math.max(0,(full-quote.production[resource])*days/100-faction.resources[resource]/1000);
    risk.shortfall[resource]=short;
    risk.shortageSeverity+=days*Math.min(1,short/Math.max(1,full*days/100));
    if(short>0)risk.shortageDays=Math.max(risk.shortageDays,Math.min(days,Math.ceil(short/Math.max(.01,full-quote.production[resource])*100/10)*10));
  }
  risk.unpaidSeverity=days*(1-(faction.welfare?.last?.fraction??1));risk.unpaidDays=risk.unpaidSeverity>0?days:0;
  risk.lowUnityDays=faction.unity<6000?days:0;risk.value=riskValueV4(risk);return risk;
}

export function makeCandidateV4(state:GameState,actions:Action[],kind:string,label:string,value:number,priority=0):ScriptCandidate {
  const first=actions[0],target=String(first.args.planetId??first.args.systemId??first.args.factionId??first.args.proposalId??'national');
  const id='v4:'+JSON.stringify(actions);
  return {id,label,kind,target,actions,priority,value,risk:0,reason:'按实际资源、岗位、履约与剩余赛程比较',evidenceDays:[state.day],progress:id,deadline:state.day+(state.config.maxRounds-state.round)*100,economic:true,exclusive:[],fingerprint:id,tasks:[]};
}

export function recoveryCandidatesV4(state:GameState,actor:string,base:ScriptCandidate[],projected?:RiskV4) {
  const result:ScriptCandidate[]=[],current=currentRiskV4(state,actor),risk=projected&&projected.value>current.value?projected:current,crisis=risk.value>0;
  const faction=state.factions[actor];
  const national:Action[]=[];
  for(const system of state.systems.filter(system=>controller(system)===actor))for(const planet of system.planets.filter(planet=>planet.ownerId===actor)) {
    const industry=industryPlanet({...planet,operation:undefined},state.day);
    const drains=planet.structures.filter(structure=>!structure.sealed&&structure.type!=='solar');
    const priorities:Action[]=(['energy','food','minerals'] as const).filter(resource=>risk.shortfall[resource]>0).map(resource=>({type:'set_jobs',args:{planetId:planet.id,structureType:resource==='energy'?'solar':resource==='food'?'farm':'mine',priority:5}})).filter(action=>planet.structures.some(structure=>structure.type===action.args.structureType)&&(planet.priorities?.[action.args.structureType as keyof typeof planet.priorities]??-1)!==5);
    for(const structure of drains) {
      if(!crisis)continue;
      const changes:Action[]=[{type:'set_structure_status',args:{planetId:planet.id,structureId:structure.id,sealed:true}},...priorities];
      const candidate=makeCandidateV4(state,changes,'recovery','封存耗能设施并保障基础岗位 '+planet.id+'/'+structure.type,crisis?1000:0,crisis?3:0);
      candidate.exclusive=['structure:'+structure.id];result.push(candidate);
      if(structure.type==='foundry')national.push(changes[0]);
    }
    if(crisis&&drains.length>1) {
      const changes:Action[]=[...drains.map(structure=>({type:'set_structure_status',args:{planetId:planet.id,structureId:structure.id,sealed:true}})),...priorities];
      const candidate=makeCandidateV4(state,changes,'recovery','整顿耗能产业并恢复基础供应 '+planet.id,1200,3);candidate.exclusive=drains.map(structure=>'structure:'+structure.id);result.push(candidate);
    }
    if(priorities.length)result.push(makeCandidateV4(state,priorities,'recovery','基础生产岗位修复 '+planet.id,800,3));
    national.push(...priorities);
    if(crisis)for(const project of system.projects.filter(project=>project.planetId===planet.id&&project.kind==='ship')) {
      const arrival=constructionView(state,system,planet).queues.flatMap(queue=>queue.projects).find(item=>item.id===project.id)?.estimatedCompleteDay;
      const threatened=militaryKnowledge(state,actor).some(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&arrivalV4(state,record.fleet.ownerId,record.fleet,system.id)<=Math.min(CONFIG.crisisDays,(arrival??Infinity)-state.day));
      if(!threatened)result.push(makeCandidateV4(state,[{type:'cancel_order',args:{projectId:project.id}}],'cancel','停止危机中的非防御造舰 '+project.id,500,3));
    }
    if(crisis&&industry.population>0)for(const type of ['solar','farm','mine'] as const) {
      const resource=type==='solar'?'energy':type==='farm'?'food':'minerals';
      if(risk.shortfall[resource]<=0)continue;
      for(const build of base.filter(candidate=>candidate.kind==='build'&&candidate.target===planet.id&&candidate.actions.some(action=>action.args.structureType===type))) {
        result.push({...build,kind:'recovery',priority:3,value:1000,reason:'按产能完成时间与岗位挤占验证供应修复'});
      }
    }
  }
  if(crisis&&national.length>1&&national.length<=40) {
    const combined=makeCandidateV4(state,national,'recovery','全国暂停冶炼并恢复电粮矿岗位',2000,3);
    combined.exclusive=national.filter(action=>action.args.structureId).map(action=>'structure:'+action.args.structureId);result.push(combined);
  }
  if(crisis)for(const candidate of base.filter(candidate=>candidate.kind==='aid'&&candidate.actions[0].type==='accept_aid'||['reform','recovery','faith'].includes(candidate.kind)))result.push({...candidate,priority:3});
  if(faction.extraction&&faction.extraction.expiresDay>state.day)for(const candidate of base.filter(candidate=>candidate.kind==='build'&&candidate.actions.some(action=>['solar','farm','mine'].includes(String(action.args.structureType)))))result.push({...candidate,priority:2});
  return result;
}

export function economicCandidatesV4(state:GameState,actor:string,candidates:ScriptCandidate[]) {
  const risk=currentRiskV4(state,actor);
  const own=state.factions[actor];
  return candidates.filter(candidate=>{
    if(['war','prepare','claim','defend','hold'].includes(candidate.kind))return false;
    if(['explore','base','colonize'].includes(candidate.kind)) {
      if(state.systems.some(system=>system.projects.some(project=>project.ownerId===actor&&(candidate.kind==='explore'?project.kind==='survey'&&system.id===candidate.target:candidate.kind==='base'?project.kind==='base'&&system.id===candidate.target:project.kind==='colonize'&&project.planetId===candidate.target))))return false;
      if(candidate.kind==='explore'&&surveyValueV4(state,actor,candidate.target)<=0)return false;
    }
    if(candidate.kind==='scout') {
      const target=state.systems.find(system=>system.id===candidate.target);
      if(target?.ownerId&&target.ownerId!==actor||target?.base&&controller(target)!==actor)return false;
      if(militaryKnowledge(state,actor).some(record=>record.fleet.systemId===candidate.target))return false;
      // Survey status is not military freshness. A visit does not authorize a perpetual patrol reward.
      if(own.militaryIntel?.[candidate.target]||own.surveyed.includes(candidate.target))return false;
      if(state.fleets.some(fleet=>fleet.ownerId===actor&&(fleet.systemId===candidate.target||fleet.order?.systemId===candidate.target||fleet.transit?.to===candidate.target)))return false;
      const fleet=state.fleets.find(fleet=>fleet.id===candidate.actions[0]?.args.fleetId);
      const path=fleet?.systemId?accessiblePath(state,actor,fleet.systemId,candidate.target):null;
      if(!path?.length)return false;
      if(path.slice(0,-1).some(id=>{
        const host=controller(state.systems.find(system=>system.id===id)!);
        return !own.militaryIntel?.[id]&&!own.intel[id]||host&&host!==actor&&state.relations[relationKey(actor,host)]?.status!=='peace';
      }))return false;
    }
    if(candidate.kind==='ships'&&risk.value>0) {
      const system=state.systems.find(system=>system.planets.some(planet=>planet.id===candidate.target));
      if(!system||!militaryKnowledge(state,actor).some(record=>canFight(state.relations[relationKey(actor,record.fleet.ownerId)])&&arrivalV4(state,record.fleet.ownerId,record.fleet,system.id)<=CONFIG.crisisDays))return false;
    }
    return true;
  }).map(candidate=>{
    if(candidate.kind==='scout') {
      const fleet=state.fleets.find(fleet=>fleet.id===candidate.actions[0].args.fleetId)!;
      const path=accessiblePath(state,actor,fleet.systemId!,candidate.target)!;
      const gate=state.systems.find(system=>system.id===candidate.target)!.gates[path.length>1?path.at(-2)!:fleet.systemId!];
      return {...candidate,actions:candidate.actions.map(action=>({...action,args:{...action.args,x:gate.x,y:gate.y}})),value:Math.min(CONFIG.scoutingValue,candidate.value),exclusive:[...candidate.exclusive,'scout:'+candidate.target],reason:'在入境星门观察，不自动驶入未知基地交战范围；首次情报不代替殖民探索'};
    }
    return candidate.kind==='explore'?{...candidate,value:surveyValueV4(state,actor,candidate.target),reason:'探索仅计未知领土的条件选择价值；不假设隐藏人口、资源或无敌军'}:candidate.kind==='base'?{...candidate,value:100,reason:'按真实基地完工日和新增法理星系分预测，不重复奖励准备动作'}:candidate.kind==='withdraw'?{...candidate,value:state.fleets.filter(fleet=>candidate.actions.some(action=>action.args.fleetId===fleet.id)).reduce((sum,fleet)=>sum+fleetPower(fleet)*.5,0),reason:'保存可撤离舰船，承担失去当地控制的代价'}:candidate;
  });
}

export function quickValueV4(state:GameState,actor:string,coverage:V3Coverage,days:number) {
  const timeline=v3StaticTimeline(state,actor,days,coverage,positionValueV4),position=positionValueV4(state,actor,state.day+(state.config.maxRounds-state.round)*100,coverage);
  const risk=currentRiskV4(state,actor,days);
  risk.shortageDays=Math.max(risk.shortageDays,timeline.shortageDays);risk.lowUnityDays=timeline.lowUnityDays;risk.value=riskValueV4(risk);
  const value=timeline.score+timeline.economy+timeline.functional-timeline.lowUnityDays*CONFIG.lowUnityDayValue;
  return {risk,value,economy:timeline.economy,functional:timeline.functional,score:timeline.score,net:position.net};
}
