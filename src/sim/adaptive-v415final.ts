import { responsibilityPackages, responsibilityTasks } from './adaptive-v415final-responsibility.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ADAPTIVE_V415Final as CONFIG, type CertificateV415Final, type RiskWindowV415Final, type ValueV415Final, type CampaignV415Final } from '../shared/adaptive-v415final.js';
import type { ScriptMemory, ScriptReport } from '../shared/adaptive.js';
import type { Action, Decision, GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { V4Hooks } from './adaptive-v4.js';
import { StagingArea } from './actions.js';
import { validateScriptPlan } from './adaptive-adapter.js';
import { candidateFacts } from './adaptive-candidates.js';
import { economicForecast } from './forecast.js';
import { forecastInput } from './adaptive-v2.js';
import { planningPreview } from './planning-preview.js';
import { applyStateChanges } from './planning-delta.js';
import { coverageV4 } from './adaptive-v4-values.js';
import { emptyRiskV4, riskValueV4 } from './adaptive-v4-economy.js';
import { economyCandidatesV415Final, welfarePackagesV415Final } from './adaptive-v415final-economy.js';
import { militaryPlansV415Final, militaryActionV415Final, tacticalV415Final, cleanTasksV415Final, campaignProgressV415Final, scoreIntervalsV415Final, type MilitaryCandidateV415Final } from './adaptive-v415final-military.js';
import { v3FailureDependency } from './adaptive-v3-failures.js';
import { dutyPaths } from './social.js';
import { actionLimit, V53 } from '../shared/governance.js';
import { activeWar, controller } from '../shared/v4.js';
import { policyComparison } from '../shared/comparison.js';
import { emptyMetrics } from './bot.js';
import { stateHash } from './math.js';
import { LABOR } from '../shared/industry.js';
import { SHIPS } from '../shared/rules.js';
import { independentBoundV415Final } from './adaptive-v415final-static.js';
import { feedbackV415Final, nationalPlanV415Final, strategicEnvelopeV415Final } from './adaptive-v415final-memory.js';
import { reconcileWarV415Final } from './adaptive-v415final-memory.js';
import { capacityV415Final, militaryDependencyV415Final, conditionalValueV415Final, commitmentBlockV415Final } from './adaptive-v415final-capacity.js';
import { developmentV415Final, developmentCandidateV415Final, developmentPackagesV415Final, protectsDevelopmentV415Final } from './adaptive-v415final-development.js';
import { portfolioV415Final, continuityV415Final } from './adaptive-v415final-portfolio.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capital=(state:GameState,actor:string)=>Object.fromEntries(['energy','food','minerals','alloys'].map(r=>[r,(state.factions[actor].resources[r as keyof GameState['factions'][string]['resources']]??0)/1000]));
type Forecast=ReturnType<typeof economicForecast>;
export interface V415FinalHooks extends Omit<V4Hooks,'tactical'> { validate?:typeof validateScriptPlan; tactical?:(state:GameState,request:import('./adaptive-v415final-military.js').TacticalRequestV415Final)=>Promise<import('../shared/adaptive-v415final.js').MilitaryOptionV415Final> }
type Group=MilitaryCandidateV415Final;
interface Branch { stage:StagingArea; groups:Group[]; projection:Forecast; certificate:CertificateV415Final; development:ReturnType<typeof developmentV415Final> }
const phaseOf=(c:Group)=>c.military||['war','scout','withdraw','peace'].includes(c.kind)?'military':['recovery','aid','reform','faith','demand','settle'].includes(c.kind)?'crisis':'economy';
const meaningful=(state:GameState,actor:string,action:Action)=>{
  const a=action.args,planet=state.systems.flatMap(s=>s.planets).find(p=>p.id===a.planetId);
  if(action.type==='set_jobs'){const type=a.structureType as keyof typeof LABOR;return (planet?.priorities?.[type]??LABOR[type]?.priority)!==a.priority;}
  if(action.type==='set_structure_status')return !!planet?.structures.find(s=>s.id===a.structureId)?.sealed!==a.sealed;
  if(action.type==='move_fleet') {
    const fleet=state.fleets.find(f=>f.id===a.fleetId&&f.ownerId===actor);
    if(!fleet)return false;
    if(fleet.order&&fleet.order.systemId===a.systemId&&fleet.order.position.x===(a.x??500)&&fleet.order.position.y===(a.y??500))return false;
    if(fleet.transit?.to===a.systemId)return false;
    if(!fleet.order&&fleet.systemId===a.systemId&&Math.hypot(fleet.position.x-Number(a.x??500),fleet.position.y-Number(a.y??500))<=20)return false;
  }
  return true;
};
const domains=(group:Group)=>[...new Set(group.actions.flatMap(a=>[...Object.entries(a.args).filter(([k])=>['planetId','structureId','fleetId','systemId','projectId','factionId'].includes(k)).map(([k,v])=>k+':'+v),...((a.args.fleetIds as string[]|undefined)??[]).map(id=>'fleetId:'+id)]))];

export function windowsV415Final(forecast:Forecast):RiskWindowV415Final[] {
  return forecast.horizons.map(row=>{
    const sample=forecast.trajectory?.find(t=>t.day===(forecast.trajectory?.[0]?.day??10)-10+row.days);
    const risk=sample?.risk??emptyRiskV4();
    return {...risk,causes:sample?.causes,value:riskValueV4(risk),days:row.days,unity:row.unity,quality:row.governance?.quality??0};
  });
}

/** Near-term survival is a constraint; long-term marginal costs are priced, never mixed with a static estimate. */
export function hardRiskV415Final(windows:RiskWindowV415Final[]) {
  const near=windows.filter(w=>w.days<=300).at(-1)??windows[0];
  return near?near.shortageDays*20+near.shortageSeverity*30+(near.causes?.fundingSeverity??near.unpaidSeverity)*20:0;
}
export function softCostV415Final(windows:RiskWindowV415Final[]) {
  // Governance and inventory loss already enter the projected score. Do not charge
  // them a second time, or turn occupied delivery into an insolvency veto.
  return 0;
}
export function hardAllowedV415Final(before:CertificateV415Final,after:CertificateV415Final,strict=false) {
  const rows=strict?after.windows:after.windows.filter(w=>w.days<=300);
  return rows.every(w=>{const old=before.windows.find(row=>row.days===w.days)!;
    const fundedRecovery=!!w.causes?.supplyRecoveryDay&&!!w.causes?.fundingRecoveryDay;
    const funding=w.causes?.fundingSeverity??w.unpaidSeverity,oldFunding=old.causes?.fundingSeverity??old.unpaidSeverity;
    if(strict)return w.shortageDays<=old.shortageDays&&w.shortageSeverity<=old.shortageSeverity+.001&&funding<=oldFunding+.001;
    if(fundedRecovery)return true;
    return w.shortageDays*20+w.shortageSeverity*30+funding*20<=old.shortageDays*20+old.shortageSeverity*30+oldFunding*20+.001;
  });
}

export async function adaptiveV415FinalDecision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:V415FinalHooks={}):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('adaptive-v4.15-final 仅支持5.4');
  const started=performance.now(),profile=world.config.scriptSearchProfile??'standard',budget=CONFIG.profiles[profile];
  const memory:ScriptMemory=previous?.version==='adaptive-v4.15-final'?structuredClone(previous):{version:'adaptive-v4.15-final',goal:null,tasks:[],failures:[]};
  feedbackV415Final(world,actor,memory);reconcileWarV415Final(world,actor,memory);campaignProgressV415Final(world,actor,memory);cleanTasksV415Final(world,actor,memory);
  const checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(r=>setImmediate(r));});
  const forecast=hooks.forecast??(async(s,a,h,c)=>economicForecast(s,a,h,c));
  const preview=hooks.preview??(async(s,a,p,c)=>planningPreview(s,a,p,c));
  const generate=hooks.candidates??(async(s,a,l)=>candidateFacts(s,a,true,l,true));
  const tactical=hooks.tactical??(async(s,r)=>tacticalV415Final(s,r));
  const endDay=world.day+(world.config.maxRounds-world.round)*100;
  const horizons=[...new Set(CONFIG.horizons.map(h=>Math.min(h,endDay-world.day)))].filter(h=>h>0);
  const boundaryHash=stateHash(world),coverage=coverageV4(world,actor);
  const report:ScriptReport={version:'adaptive-v4.15-final',candidates:0,forecasts:0,validations:0,exhausted:false,alternatives:[],selected:[],rejected:[],projections:[],search:{profile,evaluations:0,depth:0,combinations:[]},assumptions:'仅使用本方知识；同前缀同窗口预测；条件战果不作为已经兑现的事实。',v415final:{candidates:[],feedback:memory.v415final!.feedback,staticAccepted:0,certificates:[],finalCertificate:'',removed:[],selectedGroups:[],submittedGroups:[],stopReasons:[],repairs:0,rollbacks:0,forecastCacheHits:0,windows:[],militaryPlanRefreshes:0}};
  const audit=report.v415final!,stats={candidateMs:0,previewMs:0,forecastMs:0,tacticalMs:0,validationMs:0,peakRssMb:0};
  const scores=scoreIntervalsV415Final(world,actor);
  report.v4={risk:emptyRiskV4(),finalRisk:emptyRiskV4(),posture:Object.entries(scores).some(([id,s])=>id!==actor&&s.low>scores[actor].low)||endDay-world.day<=1440?'contest':'balanced',military:[],tacticalEvaluations:0,crisisChecked:false,pending:[],stageBudgets:{},scoreIntervals:scores};
  const pending=new Map<string,{candidate:Group;reason:string}>(),rejections=new Set<string>(),admitted=new Set<string>(),deferred=new Set<string>(),staticGroups=new Set<string>();
  const forecasts=new Map<string,Forecast>(),factsCache=new WeakMap<GameState,Awaited<ReturnType<typeof generate>>>();
  const candidatesCache=new WeakMap<GameState,Group[]>();
  const phaseStats:Record<string,{evaluations:number;forecasts:number;actions:number}>={combination:{evaluations:0,forecasts:0,actions:0},residual:{evaluations:0,forecasts:0,actions:0},repair:{evaluations:0,forecasts:0,actions:0}};
  const phaseLimits:Record<string,{evaluations:number;forecasts:number}>={};
  let phase='combination',phaseEvaluationLimit=budget.evaluations-3;
  const factsFor=async(s:GameState)=>{let value=factsCache.get(s);if(value)return value;const t=performance.now();value=await generate(s,actor,Number.MAX_SAFE_INTEGER);stats.candidateMs+=performance.now()-t;factsCache.set(s,value);return value;};
  const conditional=conditionalValueV415Final;
  const makeProjection=async(stage:StagingArea,groups:Group[],limit:number):Promise<Branch|null>=>{
    const state=stage.draft,input=forecastInput(state,actor);
    input.systems=state.systems.filter(s=>s.ownerId===actor||controller(s)===actor||!s.ownerId&&s.projects.some(p=>p.ownerId===actor&&p.kind==='base'));
    // Mirror the economic simulator's inputs. Orders do not execute in its no-success scenario.
    input.fleets=input.fleets.filter(f=>f.ownerId===actor).map(f=>({...f,order:null}));input.events=[];
    delete input.factions[actor].scriptMemory;
    const scenario={version:'v4.15-final' as const,actionable:dutyPaths(state,actor).actionable,coverage,endDay};
    const key=hash({input,horizons,scenario});let projection=forecasts.get(key);const reused=!!projection;
    if(projection)audit.forecastCacheHits++;
    else {
      if(report.forecasts>=limit)return null;
      report.forecasts++;phaseStats[phase].forecasts++;
      const t=performance.now();projection=await forecast(input,actor,horizons,scenario);stats.forecastMs+=performance.now()-t;forecasts.set(key,projection);
    }
    const windows=windowsV415Final(projection);
    const value:ValueV415Final={score:0,economy:0,functional:0,conditional:conditional(groups),softCost:softCostV415Final(windows),total:0};
    const divisor=projection.horizons.reduce((n,_,i)=>n+(CONFIG.valueWeights[i]??.4),0)||1;
    projection.horizons.forEach((row,i)=>{const w=(CONFIG.valueWeights[i]??.4)/divisor;value.score+=(row.governance?.score??0)*w;value.economy+=(row.governance?.value?.economy??0)*w;value.functional+=(row.governance?.value?.functional??0)*w;value.conditional+=Number((row.governance?.value as {institutionOption?:number}|undefined)?.institutionOption??0)*w;});
    const development=developmentV415Final(state,actor,projection,memory.v415final?.development);
    // Unordered development is an alternative to evaluate, not a return earned
    // by waiting. Paid colony assets and capacity already enter this forecast.
    value.total=value.score+value.economy+value.functional+value.conditional-value.softCost;
    const id=hash(stage.actions),certificate:CertificateV415Final={id,boundaryHash,prefixHash:id,draftHash:hash(stage.draft),forecastHash:hash(projection),groups:groups.map(g=>g.id),dependencies:Object.fromEntries(groups.map((g,i)=>[g.id,groups.slice(0,i).filter(p=>domains(p).some(d=>domains(g).includes(d))||p.actions.some(a=>a.type==='cancel_order')&&g.actions.some(a=>['build_structure','queue_ships','colonize_planet'].includes(a.type))).map(p=>p.id)])),exclusive:[...new Set(groups.flatMap(g=>g.exclusive))],windows,value,evidence:reused?'unchanged-economy':'forecast',status:'compared'};
    audit.certificates.push(certificate);
    if(!report.projections!.some(item=>item.id===id))report.projections!.push({id,horizons:projection.horizons});
    return {stage,groups,projection,certificate,development};
  };
  let root=(await makeProjection(new StagingArea(world,actor),[],budget.forecasts))!;
  const baseline=root;report.v4.risk={...root.certificate.windows.at(-1)!};
  const initial=await factsFor(world);report.comparisons=initial.comparisons;
  if(world.factions[actor].extraction&&initial.facts.comparison.emergencyEconomy?.withoutSubsidy){const exit=initial.facts.comparison.emergencyEconomy.withoutSubsidy;memory.recovery={deadline:world.factions[actor].extraction!.expiresDay,lastCheckedDay:world.day,shortages:{...exit.shortages},welfareFraction:exit.welfareFraction??1,normalNet:exit.resourcesPer100};}
  type MilitaryContext={key:string;attempted:boolean;plans:import('../shared/adaptive-v415final.js').MilitaryOptionV415Final[];actions:Group[]};
  const militaryContexts=new Map<string,MilitaryContext>();
  const branchContexts=new WeakMap<GameState,MilitaryContext>();
  let boundaryMilitary:import('../shared/adaptive-v415final.js').MilitaryOptionV415Final[]=[];
  const refreshMilitary=async(state:GameState,facts:Awaited<ReturnType<typeof generate>>,allowEvaluate:boolean):Promise<MilitaryContext>=>{
    const key=militaryDependencyV415Final(state,actor),cached=militaryContexts.get(key);
    if(cached&&(cached.attempted||!allowEvaluate)){branchContexts.set(state,cached);return cached;}
    audit.militaryPlanRefreshes++;
    const plans=militaryPlansV415Final(state,actor,facts,memory);
    const available=CONFIG.tacticalPlans[profile]-report.v4!.tacticalEvaluations;
    const continuing=plans.filter(p=>p.holding||p.mode==='defend'||p.opponent===memory.operation?.opponent&&p.target===memory.operation.targets[0]);
    const representatives=[...continuing.slice(0,Math.max(1,Math.floor(available/3))),...[...new Set(plans.map(p=>p.opponent))].map(k=>plans.find(p=>p.opponent===k)!)];
    const limit=!allowEvaluate?0:audit.militaryPlanRefreshes===1?Math.max(0,available-Math.ceil(CONFIG.tacticalPlans[profile]/3)):available;
    const ordered=[...new Set([...representatives,...plans.filter(p=>!representatives.includes(p))])];
    const evaluated:typeof plans=[];let spent=0;
    const t=performance.now();
    for(const option of ordered) {
      const cost=2;
      if(spent+cost>limit)continue;
      spent+=cost;report.v4!.tacticalEvaluations+=cost;
      const results=await Promise.all([tactical(state,{actor,option}),...(cost===2?[tactical(state,{actor,option:{...option,response:'wait'}})]:[])]);
      const result=results[0];result.dependencyKey=key;result.evaluated=true;
      if(results[1]) {
        result.baselineValue=results[1].value;result.baselineScenarios=results[1].scenarios;
        result.avoidedLoss=result.value-results[1].value;result.value=result.avoidedLoss;
        // Elimination in a pressure scenario is not proof of improvement.
        if(result.eliminated&&results[1].eliminated)result.value=Math.min(0,result.value);
      }
      evaluated.push(result);
    }
    stats.tacticalMs+=performance.now()-t;
    if(audit.militaryPlanRefreshes===1)boundaryMilitary=evaluated;
    report.v4!.military.push(...evaluated);audit.military=report.v4!.military;
    const context={key,attempted:allowEvaluate,plans:plans.map(p=>evaluated.find(e=>e.id===p.id)??{...p,value:0,evaluated:false,dependencyKey:key}),actions:evaluated.map(p=>militaryActionV415Final(state,actor,p,facts)).filter((p):p is Group=>!!p)};
    militaryContexts.set(key,context);branchContexts.set(state,context);
    (audit.branchMilitary??=[]).push({prefix:hash(state),dependencyKey:key,evaluated:evaluated.map(p=>p.id),deferred:context.plans.filter(p=>!p.evaluated).map(p=>p.id)});
    return context;
  };
  const candidatesFor=async(branch:Branch)=>{
    let cached=candidatesCache.get(branch.stage.draft);if(cached&&(branch!==root||branchContexts.get(branch.stage.draft)?.attempted))return cached;
    const state=branch.stage.draft,facts=await factsFor(state),context=await refreshMilitary(state,facts,branch===root);
    const availableMilitary=context.plans;
    const envelope=strategicEnvelopeV415Final(state,actor,memory,branch.certificate,availableMilitary,facts.candidates.map(c=>developmentCandidateV415Final(c,branch.development)));
    const eligibleMilitary=context.actions.filter(c=>!c.military||availableMilitary.includes(c.military));
    const economic=economyCandidatesV415Final(state,actor,facts.candidates.map(c=>({...c})),branch.projection,memory,availableMilitary,capacityV415Final(state,actor,availableMilitary,branch.development)).map(c=>developmentCandidateV415Final(c,branch.development));
    const portfolio=portfolioV415Final(state,actor,branch.projection,branch.development.alternatives);
    const all=[...eligibleMilitary,...responsibilityPackages(state,actor,economic),...developmentPackagesV415Final(state,actor,economic,branch.projection),...economic].map(c=>{
      const allocation=portfolio.allocations.find(item=>c.actions.some(action=>action.args.planetId===item.target||action.args.systemId===state.systems.find(system=>system.planets.some(planet=>planet.id===item.target))?.id));
      if(allocation&&allocation.startDay<=state.day&&['base','colonize','build'].includes(c.kind))c={...c,priority:Math.max(c.priority,2),reason:c.reason+'；共享资源账已覆盖开发链付款'};
      const actions=c.actions.filter(a=>meaningful(state,actor,a));
      return actions.length===c.actions.length?c:{...c,actions,id:'v415final:normalized:'+hash(actions)};
    });
    const seen=new Set(branch.groups.map(g=>g.id)),used=new Set(branch.groups.flatMap(g=>g.exclusive));
    cached=[...new Map(all.map(c=>[hash(c.actions),c])).values()].filter(c=>!seen.has(c.id)&&!c.exclusive.some(k=>used.has(k))&&c.actions.length&&c.actions.some(a=>meaningful(state,actor,a))).filter(c=>!memory.failures.some(f=>f.key===c.id&&f.fingerprint===v3FailureDependency(state,actor,c.actions,f.reason)));
    const relevance=(c:Group)=>c.military&&envelope?.selected?.planKey===c.military.planKey?1:envelope?.kind==='recover'&&phaseOf(c)==='crisis'?1:0;
    cached=cached.filter(c=>!rejections.has(branch.certificate.id+':'+c.id)).sort((a,b)=>b.priority-a.priority||relevance(b)-relevance(a)||b.value-a.value||a.id.localeCompare(b.id,'en'));
    candidatesCache.set(state,cached);return cached;
  };
  const reject=(parent:Branch,candidate:Group,reason:string)=>{pending.set(candidate.id,{candidate,reason});rejections.add(parent.certificate.id+':'+candidate.id);audit.candidates.push({id:candidate.id,prefix:parent.certificate.id,state:/资源|岗位|路径|条件/.test(reason)?'blocked':/48|非法/.test(reason)?'illegal':'inferior',reason,phase});};
  const defer=(parent:Branch,candidate:Group,reason:string)=>{pending.set(candidate.id,{candidate,reason});deferred.add(phase+':'+parent.certificate.id+':'+candidate.id);audit.candidates.push({id:candidate.id,prefix:parent.certificate.id,state:'deferred',reason,phase});};
  const staticBranch=(parent:Branch,p:{stage:StagingArea;groups:Group[]}):Branch|null=>{
    const candidate=p.groups.at(-1)!;if(candidate.military||p.groups.length!==parent.groups.length+1)return null;
    const bound=independentBoundV415Final(parent.stage.draft,p.stage.draft,actor,candidate,parent.projection);if(!bound)return null;
    const id=hash(p.stage.actions),certificate:CertificateV415Final={...structuredClone(parent.certificate),id,prefixHash:id,draftHash:hash(p.stage.draft),forecastHash:hash(bound.projection),groups:p.groups.map(g=>g.id),evidence:'static-bound',status:'compared',dependencies:{...parent.certificate.dependencies,[candidate.id]:parent.groups.filter(g=>domains(g).some(d=>domains(candidate).includes(d))).map(g=>g.id)}};
    const development=developmentV415Final(p.stage.draft,actor,bound.projection,memory.v415final?.development);

    certificate.value.total+=bound.gain;certificate.value.economy+=bound.gain;audit.certificates.push(certificate);staticGroups.add(candidate.id);
    return {...p,projection:bound.projection,certificate,development};
  };
  const previewGroup=async(parent:Branch,candidate:Group):Promise<{stage:StagingArea;groups:Group[];hint:number}|null>=>{
    if(report.search!.evaluations>=phaseEvaluationLimit)return null;
    if(!admitted.has(candidate.id)&&admitted.size>=budget.candidates){defer(parent,candidate,'本轮候选预算耗尽，尚未比较');return null;}
    const commitment=candidate.actions.find(a=>a.type==='establish_civilization'||a.type==='establish_religion');
    if(commitment){const reason=commitmentBlockV415Final(parent.stage.draft,actor,commitment.type==='establish_religion'?'theocracy':String(commitment.args.civilization),branchContexts.get(parent.stage.draft)?.plans??[]);if(reason){reject(parent,candidate,reason);return null;}}
    if(parent.stage.actions.length+candidate.actions.length>actionLimit(world)){reject(parent,candidate,'展开动作超过48条');return null;}
    admitted.add(candidate.id);report.candidates=admitted.size;report.search!.evaluations++;phaseStats[phase].evaluations++;
    const t=performance.now(),outcome=await preview(parent.stage.draft,actor,parent.stage.actions,candidate);stats.previewMs+=performance.now()-t;
    if(!outcome.changes){reject(parent,candidate,outcome.error??'本方可知条件不满足');return null;}
    const draft=applyStateChanges(parent.stage.draft,outcome.changes),stage=new StagingArea(draft,actor,false);stage.actions=outcome.actions!;
    const before=policyComparison(parent.stage.draft,actor,[parent.stage.draft.factions[actor].policy?.choice??'none'])[0];
    const after=policyComparison(draft,actor,[draft.factions[actor].policy?.choice??'none'])[0];
    if(candidate.kind==='jobs'&&JSON.stringify(before.net)===JSON.stringify(after.net)&&!draft.systems.some(s=>s.projects.some(p=>p.planetId===candidate.target))) {reject(parent,candidate,'岗位分配及实际收支未改变，未预留任何在建岗位');return null;}
    const urgency=parent.certificate.windows.some(w=>w.value>0);
    // Screening only. This estimate is never used to certify or rank accepted branches.
    const marginal=(after.net.energy-before.net.energy)+(after.net.food-before.net.food)+(after.net.minerals-before.net.minerals)+2*(after.net.alloys-before.net.alloys);
    return {stage,groups:[...parent.groups,candidate],hint:candidate.military?candidate.value:candidate.kind==='recovery'?marginal*(urgency?10:1):candidate.value+marginal};
  };
  const improves=(parent:Branch,child:Branch)=>{
    const added=child.groups.slice(parent.groups.length);
    const priorWelfare=parent.stage.draft.factions[actor].welfare?.choice??'basic';
    const nextWelfare=child.stage.draft.factions[actor].welfare?.choice??'basic';
    const strict=added.some(g=>g.kind==='civilization')||V53.treatment[nextWelfare]>V53.treatment[priorWelfare];
    if(!hardAllowedV415Final(parent.certificate,child.certificate,strict))return false;
    const before=hardRiskV415Final(parent.certificate.windows),after=hardRiskV415Final(child.certificate.windows);
    if(before>0&&after<before-1)return true;
    const discretionary=added.some(group=>['ships','war','prepare','claim','welfare','civilization'].includes(group.kind));
    const urgent=added.some(group=>group.military&&(group.military.mode==='defend'||group.military.holding||activeWar(parent.stage.draft,actor,group.military.opponent)));
    let opportunityCost=0;
    if(discretionary&&!urgent) {
      const prior=portfolioV415Final(parent.stage.draft,actor,parent.projection,parent.development.alternatives);
      const next=portfolioV415Final(child.stage.draft,actor,child.projection,child.development.alternatives);
      opportunityCost=Math.max(0,prior.conditionalValue-next.conditionalValue);
    }
    return child.certificate.value.total>parent.certificate.value.total+opportunityCost+CONFIG.minimumGain;
  };
  const compare=(a:Branch,b:Branch)=>{const ar=hardRiskV415Final(a.certificate.windows),br=hardRiskV415Final(b.certificate.windows);return (ar>0&&br>0?Math.round(ar)-Math.round(br):0)||Math.round((b.certificate.value.total-a.certificate.value.total)*1000)||a.certificate.id.localeCompare(b.certificate.id,'en');};
  const accept=(branch:Branch)=>{const added=branch.groups.slice(root.groups.length);branch.certificate.status='accepted';phaseStats[phase].actions+=branch.stage.actions.length-root.stage.actions.length;for(const c of added){audit.selectedGroups.push({id:c.id,phase,actions:c.actions.length});pending.delete(c.id);audit.candidates.push({id:c.id,prefix:root.certificate.id,state:'selected',reason:'通过当前前缀边际比较',phase});}if(branch.certificate.evidence==='static-bound')audit.staticAccepted+=added.length;root=branch;};
  const comboLimit=Math.floor((budget.evaluations-3)*(1-CONFIG.residualShare));
  const comboForecastLimit=budget.forecasts-CONFIG.repairForecasts-1-Math.ceil((budget.forecasts-1)*CONFIG.residualForecastShare);
  for(phase of ['crisis','development','combination','residual']) {
    phaseStats[phase]??={evaluations:0,forecasts:0,actions:0};
    const phaseIndex=['crisis','development','combination','residual'].indexOf(phase);
    const evaluationLimit=phase==='residual'?budget.evaluations-3:Math.floor((budget.evaluations-3)*(phaseIndex+1)/4);
    phaseEvaluationLimit=evaluationLimit;
    const forecastLimit=phase==='residual'?budget.forecasts-CONFIG.repairForecasts:1+Math.floor((budget.forecasts-CONFIG.repairForecasts-1)*(phaseIndex+1)/4);
    phaseLimits[phase]={evaluations:Math.max(0,evaluationLimit-report.search!.evaluations),forecasts:Math.max(0,forecastLimit-report.forecasts)};
    while(report.search!.evaluations<evaluationLimit&&root.stage.actions.length<actionLimit(world)) {
      await checkpoint();
      const all=(await candidatesFor(root)).filter(c=>!rejections.has(root.certificate.id+':'+c.id)&&!deferred.has(phase+':'+root.certificate.id+':'+c.id)).filter(c=>phase==='crisis'?phaseOf(c)==='crisis'||c.military?.mode==='defend':phase==='development'?phaseOf(c)==='economy':true);if(!all.length)break;
      // Each category participates before a high-volume category can exhaust the shortlist.
      const heads=['crisis','military','economy'].flatMap(category=>all.filter(c=>phaseOf(c)===category).slice(0,Math.max(1,Math.floor(budget.width/3))));
      const family=(candidate:Group)=>candidate.military?'military:'+candidate.military.opponent:['welfare','civilization'].includes(candidate.kind)?'governance':['base','colonize','explore'].includes(candidate.kind)?'development':candidate.kind==='ships'?'ships':candidate.kind==='build'?'production:'+String(candidate.actions[0].args.structureType):candidate.kind;
      const families=new Set<string>();
      const diverse=[...heads,...all.filter(candidate=>!heads.includes(candidate))].filter(candidate=>{const key=family(candidate);if(families.has(key))return false;families.add(key);return true;});
      const shortlist=[...diverse,...all.filter(candidate=>!diverse.includes(candidate))].slice(0,Math.min(budget.width,evaluationLimit-report.search!.evaluations));
      const previews=(await Promise.all(shortlist.map(c=>previewGroup(root,c)))).filter((p):p is NonNullable<typeof p>=>!!p).sort((a,b)=>b.hint-a.hint||hash(a.stage.actions).localeCompare(hash(b.stage.actions),'en'));
      const choices:Branch[]=[];
      // Independently payable residual orders share a forecast without consuming one forecast per planet.
      if(phase==='residual'&&previews.length>1&&report.forecasts<forecastLimit) {
        let grouped={stage:root.stage,groups:root.groups};const used=new Set(root.groups.flatMap(g=>g.exclusive));
        for(const p of previews.slice(0,CONFIG.repairBatch)) {
          const c=p.groups.at(-1)!;if(c.military||!['build','jobs','colonize','base'].includes(c.kind)||c.exclusive.some(k=>used.has(k)))continue;
          const proxy={...root,...grouped};const next=await previewGroup(proxy,c);if(next){grouped=next;for(const k of c.exclusive)used.add(k);}
        }
        if(grouped.groups.length>root.groups.length+1){const child=await makeProjection(grouped.stage,grouped.groups,forecastLimit);if(child&&improves(root,child))choices.push(child);}
      }
      let frontier:Branch[]=[];
      for(const p of previews) {
        const exact=await makeProjection(p.stage,p.groups,forecastLimit);
        const child=exact??(phase==='residual'?staticBranch(root,p):null);
        if(!child){defer(root,p.groups.at(-1)!,'本阶段预测额度不足；保留为待比较机会');continue;}
        frontier.push(child);report.search!.depth=Math.max(report.search!.depth,1);
        if(improves(root,child))choices.push(child);
        else {
          child.certificate.status='rejected';child.certificate.reason??='同窗口生存风险或实际收益不优于当前已验证方案';
          reject(root,p.groups.at(-1)!,child.certificate.reason);
        }
      }
      // Expand dependent combinations to the selected profile's depth under the same round budget.
      for(let depth=2;phase==='combination'&&depth<=budget.depth&&frontier.length&&report.search!.evaluations<evaluationLimit&&report.forecasts<forecastLimit;depth++) {
        const nextFrontier:Branch[]=[];
        for(const parent of frontier.sort(compare).slice(0,budget.width)) {
          const related=parent.groups.slice(root.groups.length).flatMap(domains);
          const next=(await candidatesFor(parent)).filter(c=>domains(c).some(d=>related.includes(d))&&c.actions.some(action=>!parent.groups.flatMap(group=>group.actions).some(prior=>JSON.stringify(prior)===JSON.stringify(action)))).slice(0,2);
          for(const c of next) {
            const paired=await previewGroup(parent,c);if(!paired)continue;
            const child=await makeProjection(paired.stage,paired.groups,forecastLimit);if(!child)continue;
            report.search!.depth=Math.max(report.search!.depth,depth);nextFrontier.push(child);
            if(improves(root,child))choices.push(child);
          }
        }
        frontier=nextFrontier;
      }
      if(choices.length){choices.sort(compare);accept(choices[0]);}
      else for(const c of shortlist)if(!deferred.has(phase+':'+root.certificate.id+':'+c.id))reject(root,c,pending.get(c.id)?.reason??'已比较组合无可验证改善');
      if(!previews.length&&shortlist.every(c=>rejections.has(root.certificate.id+':'+c.id)))continue;
    }
  }
  phase='repair';report.v4.crisisChecked=true;
  let riskFailure:Group|undefined;
  if(root.certificate.evidence==='static-bound') {
    const exact=await makeProjection(root.stage,root.groups,budget.forecasts);
    if(!exact)throw new Error('V4.15 最终预测额度不足，整轮暂停');
    if(!hardAllowedV415Final(baseline.certificate,exact.certificate))riskFailure=[...root.groups].reverse().find(g=>staticGroups.has(g.id));
    if(!hardAllowedV415Final(baseline.certificate,exact.certificate)&&!riskFailure)throw new Error('V4.15 无法归因最终风险，整轮暂停');
    root=exact;
  }
  // Every accepted prefix is already forecast-certified. Replaying the exact plan must reproduce it.
  const validate=hooks.validate??validateScriptPlan;
  const t=performance.now();let checked=validate(world,actor,root.stage.actions);report.validations=1;report.search!.evaluations++;phaseStats.repair.evaluations++;
  if(checked.ok&&riskFailure)checked={...checked,ok:false,index:root.stage.actions.findIndex(a=>riskFailure!.actions.some(b=>JSON.stringify(a)===JSON.stringify(b))),reason:'静态动作组最终风险上升；移除该组及依赖后逐组重评'};
  while(!checked.ok&&report.validations<3) {
    const failed=root.stage.actions[checked.index],bad=root.groups.find(g=>g.actions.some(a=>JSON.stringify(a)===JSON.stringify(failed)));
    if(!bad)throw new Error('V4.15 无法归因最终校验失败，整轮暂停');
    const removed=new Set([bad.id]);let changed=true;while(changed){changed=false;for(const g of root.groups)if(!removed.has(g.id)&&root.certificate.dependencies[g.id]?.some(id=>removed.has(id))){removed.add(g.id);changed=true;}}
    audit.removed.push({id:bad.id,actions:bad.actions,reason:checked.reason,dependents:[...removed].filter(id=>id!==bad.id)});audit.rollbacks++;audit.repairs++;
    let retained=baseline;
    for(const g of root.groups.filter(g=>!removed.has(g.id))) {
      const stage=new StagingArea(retained.stage.draft,actor);stage.actions=[...retained.stage.actions];stage.trace=[...retained.stage.trace];
      for(const action of g.actions){const result=stage.execute(action.type,action.args);if(!result.ok)throw new Error('V4.15 独立动作重放失败，整轮暂停：'+result.error);}
      const next=await makeProjection(stage,[...retained.groups,g],budget.forecasts);
      if(!next)throw new Error('V4.15 风险修复额度不足，整轮暂停');
      if(improves(retained,next))retained=next;else audit.removed.push({id:g.id,actions:g.actions,reason:'依赖删除后边际风险或收益不再合格',dependents:[]});
    }
    if(root.groups.length&&!retained.groups.length)throw new Error('V4.15 最终校验无法保留有效计划，整轮暂停');
    root=retained;checked=validate(world,actor,root.stage.actions);report.validations++;report.search!.evaluations++;phaseStats.repair.evaluations++;
  }
  stats.validationMs=performance.now()-t;
  if(!checked.ok)throw new Error('V4.15 三次原边界校验失败，整轮暂停：'+checked.reason);
  if(hash(checked.stage.draft)!==root.certificate.draftHash)throw new Error('V4.15 最终草稿与证书不一致，整轮暂停');
  root.certificate.status='final';audit.finalCertificate=root.certificate.id;audit.submittedGroups=root.groups.map(g=>g.id);audit.windows=root.certificate.windows;report.selectedProjection=root.certificate.id;
  const finalProjection=report.projections!.find(projection=>projection.id===root.certificate.id);
  if(finalProjection)finalProjection.trajectory=root.projection.trajectory;
  for(const g of root.groups){report.selected.push({id:g.id,label:g.label,actions:g.actions,fingerprint:v3FailureDependency(world,actor,g.actions,'共同结算归属失败')});memory.tasks=memory.tasks.filter(t=>!g.tasks.some(n=>n.fleetId===t.fleetId));memory.tasks.push(...g.tasks);
    if(g.military&&g.military.mode!=='defend'){
      const option=g.military,prior=memory.operation as CampaignV415Final|undefined,war=activeWar(checked.stage.draft,actor,option.opponent),same=prior?.opponent===option.opponent&&prior.targets[0]===option.target;
      memory.operation={...(same?prior:{}),id:same?prior!.id:option.id,opponent:option.opponent,targets:[option.target],warType:option.warType,stage:g.kind==='settle'?'settle':g.kind==='hold'?'control':g.kind==='war'?'attack':g.kind==='prepare'?'prepare':g.kind==='scout'?'recon':'assemble',fleetIds:option.fleetIds.filter(id=>checked.stage.draft.fleets.some(f=>f.id===id)),staging:option.staging,createdDay:same?prior!.createdDay:world.day,deadline:same?prior!.deadline:Math.min(endDay,option.expectedDay+600),progress:same?prior!.progress:'',lastProgressRound:same?prior!.lastProgressRound:world.round,value:option.value,reserve:{},blockers:option.blockers,nextStep:g.kind==='hold'?'保持连续控制，检查二次支援与反击到达':g.kind==='war'?'主力进攻；按计划输送支援并守满控制期限':'锁定首攻名单，推进集结与准备；新舰进入二次支援',launchDay:option.ready?world.day:null,ready:option.ready,warId:war?.id,waves:option.waves,assessment:same&&prior!.reassess?'reinforce':'continue',reassess:false,launchBy:same?prior!.launchBy:Math.min(endDay-200,option.expectedDay),shipIds:checked.stage.draft.fleets.filter(f=>option.fleetIds.includes(f.id)).flatMap(f=>f.ships.map(s=>s.id))} as CampaignV415Final;
      memory.goal={id:option.id,kind:g.kind,target:option.target,stage:memory.operation.stage,value:option.value,prerequisites:option.blockers,deadline:memory.operation.deadline,progress:memory.operation.progress,lastProgressRound:memory.operation.lastProgressRound};
      for(const task of memory.tasks)if(task.campaignId===option.id)task.campaignId=memory.operation.id;
    }
  }
  const operation=memory.operation as CampaignV415Final|undefined;
  if(operation&&operation.stage!=='exit'&&!root.groups.some(g=>g.military&&g.military.mode!=='defend')) {
    const continuing=boundaryMilitary.filter(p=>p.opponent===operation.opponent&&p.target===operation.targets[0]).sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id))[0];
    if(continuing){
      operation.blockers=[...continuing.blockers];operation.ready=continuing.ready&&!continuing.unknown;
      if(continuing.eliminated||operation.reassess&&continuing.value<=0){operation.assessment='exit';operation.stage='exit';operation.reserve={};operation.exitReason='本轮边界复核：现役与已付款支援无法兑现收益，退出旧分配';operation.nextStep=operation.exitReason;memory.tasks=memory.tasks.filter(t=>t.campaignId!==operation.id);}
      else if(continuing.unknown){operation.stage='recon';operation.nextStep='主力名单保留；取得目标新鲜军情，比较合法侦察、LRS完工及换目标';}
      else if(operation.reassess){operation.assessment=continuing.variant==='supported'?'reinforce':'continue';operation.nextStep=continuing.ready?'主力已集齐：检查合法宣战、进军和本土防守':'复核继续有效计划；等待指定舰队或补足支援缺口';}
    }
  }
  audit.development=root.development;
  memory.v415final!.development=root.development.selected;
  if(!root.development.selected)delete memory.v415final!.development;
  if(operation&&operation.stage!=='exit'&&!activeWar(checked.stage.draft,actor,operation.opponent)&&root.development.optionValue>operation.value&&!root.groups.some(g=>g.military)) {
    operation.stage='exit';operation.assessment='exit';operation.exitReason='合法殖民开发的条件收益高于主动战役；释放未付款军备储资';operation.nextStep=operation.exitReason;operation.reserve={};
    memory.tasks=memory.tasks.filter(t=>t.campaignId!==operation.id);
  }
  memory.v415final!.national=nationalPlanV415Final(checked.stage.draft,actor,memory,root.groups,root.certificate,baseline.certificate);audit.national=memory.v415final!.national;
  const finalPlans=branchContexts.get(checked.stage.draft)?.plans??branchContexts.get(root.stage.draft)?.plans??[];
  const finalCapacity=capacityV415Final(checked.stage.draft,actor,finalPlans,root.development);
  audit.capacity=finalCapacity;memory.v415final!.capacity=finalCapacity;
  audit.portfolio=portfolioV415Final(checked.stage.draft,actor,root.projection,root.development.alternatives);
  memory.v415final!.portfolio=audit.portfolio;
  audit.tasks=[...continuityV415Final(world,actor,memory,audit.portfolio),...responsibilityTasks(world,actor,memory)];
  memory.v415final!.tasks=audit.tasks;
  const envelope=strategicEnvelopeV415Final(checked.stage.draft,actor,memory,root.certificate,finalPlans,[]);
  audit.national.alternatives=envelope.alternatives;
  audit.national.reserve=Object.fromEntries(Object.entries(finalCapacity.resources).map(([r,v])=>[r,v.reserved]));
  if(root.development.selected&&(!operation||operation.stage==='exit')&&envelope?.kind!=='recover'&&envelope?.kind!=='defend') {
    const development=root.development.selected;
    Object.assign(audit.national,{kind:'develop',target:development.planetId,id:development.id,reason:development.reason,reserve:development.reserve,projects:development.projects,deadline:development.productiveDay,nextStep:`${development.next} ${development.planetId}；预计${development.readyDay}日具备资金/前提，${development.colonyDay}日殖民完成`,completion:'基地、殖民及首项生产实际完成；逐轮复核供应与竞争归属'});
  }
  const expected=root.projection.horizons.find(h=>h.days===100);
  if(expected)memory.v415final!.expected={round:world.round+1,unity:expected.unity,quality:expected.governance?.quality??0,resources:expected.resources,ships:checked.stage.draft.fleets.filter(f=>f.ownerId===actor).flatMap(f=>f.ships.map(s=>s.id)),target:memory.operation?.targets[0],heldDays:(memory.operation as CampaignV415Final|undefined)?.milestones?.held??0};
  const opportunities=[...pending.values()].filter(p=>!audit.submittedGroups.includes(p.candidate.id)).sort((a,b)=>b.candidate.value-a.candidate.value||a.candidate.id.localeCompare(b.candidate.id,'en'));
  const stop=checked.stage.actions.length>=48?'达到48条实际动作上限':report.search!.evaluations>=budget.evaluations-3?'草稿评估预算耗尽':report.forecasts>=budget.forecasts-CONFIG.repairForecasts?'预测预算耗尽；保留已验证计划，仍有待比较机会':opportunities.some(p=>/资源|余额/.test(p.reason))?'资源受限；其余已比较机会无净收益':'已比较机会无净收益';
  audit.stopReasons=[...new Set([stop,...opportunities.slice(0,3).map(p=>p.reason)])];
  report.turn={revision:CONFIG.revision,actions:checked.stage.actions.length,planets:new Set(checked.stage.actions.map(a=>a.args.planetId).filter(Boolean)).size,stop,stages:phaseStats,opportunities:opportunities.slice(0,3).map(p=>({id:p.candidate.id,label:p.candidate.label,reason:p.reason,value:p.candidate.value})),value:{...root.certificate.value,governanceCost:root.certificate.value.softCost},welfareSafe:hardAllowedV415Final(baseline.certificate,root.certificate),threats:report.v4.military.filter(p=>p.mode==='defend')};
  report.v4.finalRisk={...root.certificate.windows.at(-1)!};report.v4.pending=opportunities.slice(0,32).map(p=>({id:p.candidate.id,reason:p.reason,dependency:root.certificate.id}));
  report.v4.stageBudgets=Object.fromEntries(Object.entries(phaseStats).map(([name,s])=>[name,{evaluations:s.evaluations,forecasts:s.forecasts,limit:phaseLimits[name]?.evaluations??3,forecastLimit:phaseLimits[name]?.forecasts??CONFIG.repairForecasts}]));
  report.alternatives=opportunities.slice(0,3).map(p=>({id:p.candidate.id,label:p.candidate.label,priority:p.candidate.priority,value:p.candidate.value,risk:0,reason:p.reason,evidenceDays:p.candidate.evidenceDays,selected:false}));
  report.exhausted=stop.includes('预算');stats.peakRssMb=process.memoryUsage().rss/2**20;report.performance=stats;
  await hooks.inputAudit?.({revision:CONFIG.revision,boundaryHash,actor,profile,finalCertificate:root.certificate,operation:memory.operation});
  return {actions:checked.stage.actions,trace:checked.stage.trace,scriptMemory:memory,scriptReport:report,summary:`adaptive-v4.15-final ${checked.stage.actions.length}条动作；${root.groups.slice(0,5).map(g=>g.label).join('；')}；${stop}`,metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v4.15-final'}};
}


