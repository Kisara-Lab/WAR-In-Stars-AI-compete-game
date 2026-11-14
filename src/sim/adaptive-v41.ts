import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ADAPTIVE_V41 as CONFIG, type CertificateV41, type RiskWindowV41, type ValueV41, type CampaignV41 } from '../shared/adaptive-v41.js';
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
import { economyCandidatesV41 } from './adaptive-v41-economy.js';
import { militaryPlansV41, militaryActionV41, tacticalV41, cleanTasksV41, campaignProgressV41, scoreIntervalsV41, type MilitaryCandidateV41 } from './adaptive-v41-military.js';
import { v3FailureDependency } from './adaptive-v3-failures.js';
import { dutyPaths } from './social.js';
import { actionLimit, V53 } from '../shared/governance.js';
import { activeWar, controller } from '../shared/v4.js';
import { policyComparison } from '../shared/comparison.js';
import { emptyMetrics } from './bot.js';
import { stateHash } from './math.js';
import { LABOR } from '../shared/industry.js';
import { reconcileWarV41 } from './adaptive-v41-memory.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Forecast=ReturnType<typeof economicForecast>;
export interface V41Hooks extends V4Hooks { validate?:typeof validateScriptPlan }
type Group=MilitaryCandidateV41;
interface Branch { stage:StagingArea; groups:Group[]; projection:Forecast; certificate:CertificateV41 }
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

export function windowsV41(forecast:Forecast):RiskWindowV41[] {
  return forecast.horizons.map(row=>{
    const sample=forecast.trajectory?.find(t=>t.day===(forecast.trajectory?.[0]?.day??10)-10+row.days);
    const risk=sample?.risk??emptyRiskV4();
    return {...risk,value:riskValueV4(risk),days:row.days,unity:row.unity,quality:row.governance?.quality??0};
  });
}

/** Near-term survival is a constraint; long-term marginal costs are priced, never mixed with a static estimate. */
export function hardRiskV41(windows:RiskWindowV41[]) {
  const near=windows.filter(w=>w.days<=300).at(-1)??windows[0];
  return near?near.shortageDays*20+near.shortageSeverity*30+near.unpaidSeverity*20:0;
}
export function softCostV41(windows:RiskWindowV41[]) {
  let previous=emptyRiskV4(),cost=0;
  windows.forEach((w,index)=>{cost+=Math.max(0,w.value-previous.value)*(CONFIG.softWeights[index]??.15);previous=w;});
  return cost;
}
export function hardAllowedV41(before:CertificateV41,after:CertificateV41,strict=false) {
  const rows=strict?after.windows:after.windows.filter(w=>w.days<=300);
  return rows.every(w=>{const old=before.windows.find(row=>row.days===w.days)!;
    return w.shortageDays<=old.shortageDays&&w.shortageSeverity<=old.shortageSeverity+.001&&w.unpaidSeverity<=old.unpaidSeverity+.001;
  });
}

export async function adaptiveV41Decision(world:GameState,actor:string,previous:ScriptMemory|undefined,hooks:V41Hooks={}):Promise<Decision> {
  if(world.rulesRevision!=='5.4')throw new Error('adaptive-v4.1 仅支持5.4');
  const started=performance.now(),profile=world.config.scriptSearchProfile??'standard',budget=CONFIG.profiles[profile];
  const memory:ScriptMemory=previous?.version==='adaptive-v4.1'?structuredClone(previous):{version:'adaptive-v4.1',goal:null,tasks:[],failures:[]};
  reconcileWarV41(world,actor,memory);cleanTasksV41(world,actor,memory);campaignProgressV41(world,actor,memory);
  const checkpoint=hooks.checkpoint??(async()=>{await new Promise<void>(r=>setImmediate(r));});
  const forecast=hooks.forecast??(async(s,a,h,c)=>economicForecast(s,a,h,c));
  const preview=hooks.preview??(async(s,a,p,c)=>planningPreview(s,a,p,c));
  const generate=hooks.candidates??(async(s,a,l)=>candidateFacts(s,a,true,l,true));
  const tactical=hooks.tactical??(async(s,r)=>tacticalV41(s,r));
  const endDay=world.day+(world.config.maxRounds-world.round)*100;
  const horizons=[...new Set(CONFIG.horizons.map(h=>Math.min(h,endDay-world.day)))].filter(h=>h>0);
  const boundaryHash=stateHash(world),coverage=coverageV4(world,actor);
  const report:ScriptReport={version:'adaptive-v4.1',candidates:0,forecasts:0,validations:0,exhausted:false,alternatives:[],selected:[],rejected:[],projections:[],search:{profile,evaluations:0,depth:0,combinations:[]},assumptions:'仅使用本方知识；同前缀同窗口预测；条件战果不作为已经兑现的事实。',v41:{certificates:[],finalCertificate:'',removed:[],selectedGroups:[],submittedGroups:[],stopReasons:[],repairs:0,rollbacks:0,forecastCacheHits:0,windows:[],militaryPlanRefreshes:0}};
  const audit=report.v41!,stats={candidateMs:0,previewMs:0,forecastMs:0,tacticalMs:0,validationMs:0,peakRssMb:0};
  const scores=scoreIntervalsV41(world,actor);
  report.v4={risk:emptyRiskV4(),finalRisk:emptyRiskV4(),posture:Object.entries(scores).some(([id,s])=>id!==actor&&s.low>scores[actor].low)||endDay-world.day<=1440?'contest':'balanced',military:[],tacticalEvaluations:0,crisisChecked:false,pending:[],stageBudgets:{},scoreIntervals:scores};
  const pending=new Map<string,{candidate:Group;reason:string}>(),rejections=new Set<string>(),admitted=new Set<string>();
  const forecasts=new Map<string,Forecast>(),factsCache=new WeakMap<GameState,Awaited<ReturnType<typeof generate>>>();
  const candidatesCache=new WeakMap<GameState,Group[]>();
  const phaseStats:Record<string,{evaluations:number;forecasts:number;actions:number}>={combination:{evaluations:0,forecasts:0,actions:0},residual:{evaluations:0,forecasts:0,actions:0},repair:{evaluations:0,forecasts:0,actions:0}};
  let phase='combination',phaseEvaluationLimit=budget.evaluations-3;
  const factsFor=async(s:GameState)=>{let value=factsCache.get(s);if(value)return value;const t=performance.now();value=await generate(s,actor,Number.MAX_SAFE_INTEGER);stats.candidateMs+=performance.now()-t;factsCache.set(s,value);return value;};
  const conditional=(groups:Group[])=>groups.reduce((n,g)=>n+(g.military?g.value:['scout','explore','contact'].includes(g.kind)?Math.max(0,g.value):0),0);
  const makeProjection=async(stage:StagingArea,groups:Group[],limit:number):Promise<Branch|null>=>{
    const state=stage.draft,input=forecastInput(state,actor);
    input.systems=state.systems.filter(s=>s.ownerId===actor||controller(s)===actor||!s.ownerId&&s.projects.some(p=>p.ownerId===actor&&p.kind==='base'));
    // Mirror the economic simulator's inputs. Orders do not execute in its no-success scenario.
    input.fleets=input.fleets.filter(f=>f.ownerId===actor).map(f=>({...f,order:null}));input.events=[];
    delete input.factions[actor].scriptMemory;
    const scenario={version:'v4.1' as const,actionable:dutyPaths(state,actor).actionable,coverage,endDay};
    const key=hash({input,horizons,scenario});let projection=forecasts.get(key);const reused=!!projection;
    if(projection)audit.forecastCacheHits++;
    else {
      if(report.forecasts>=limit)return null;
      report.forecasts++;phaseStats[phase].forecasts++;
      const t=performance.now();projection=await forecast(input,actor,horizons,scenario);stats.forecastMs+=performance.now()-t;forecasts.set(key,projection);
    }
    const windows=windowsV41(projection);
    const value:ValueV41={score:0,economy:0,functional:0,conditional:conditional(groups),softCost:softCostV41(windows),total:0};
    const divisor=projection.horizons.reduce((n,_,i)=>n+(CONFIG.valueWeights[i]??.4),0)||1;
    projection.horizons.forEach((row,i)=>{const w=(CONFIG.valueWeights[i]??.4)/divisor;value.score+=(row.governance?.score??0)*w;value.economy+=(row.governance?.value?.economy??0)*w;value.functional+=(row.governance?.value?.functional??0)*w;});
    value.total=value.score+value.economy+value.functional+value.conditional-value.softCost;
    const id=hash(stage.actions),certificate:CertificateV41={id,boundaryHash,prefixHash:id,draftHash:hash(stage.draft),forecastHash:hash(projection),groups:groups.map(g=>g.id),dependencies:Object.fromEntries(groups.map((g,i)=>[g.id,groups.slice(0,i).filter(p=>domains(p).some(d=>domains(g).includes(d))||p.actions.some(a=>a.type==='cancel_order')&&g.actions.some(a=>['build_structure','queue_ships','colonize_planet'].includes(a.type))).map(p=>p.id)])),exclusive:[...new Set(groups.flatMap(g=>g.exclusive))],windows,value,evidence:reused?'unchanged-economy':'forecast',status:'compared'};
    audit.certificates.push(certificate);report.projections!.push({id,horizons:projection.horizons,trajectory:projection.trajectory});
    return {stage,groups,projection,certificate};
  };
  let root=(await makeProjection(new StagingArea(world,actor),[],budget.forecasts))!;
  const baseline=root;report.v4.risk={...root.certificate.windows.at(-1)!};
  const initial=await factsFor(world);report.comparisons=initial.comparisons;
  if(world.factions[actor].extraction&&initial.facts.comparison.emergencyEconomy?.withoutSubsidy){const exit=initial.facts.comparison.emergencyEconomy.withoutSubsidy;memory.recovery={deadline:world.factions[actor].extraction!.expiresDay,lastCheckedDay:world.day,shortages:{...exit.shortages},welfareFraction:exit.welfareFraction??1,normalNet:exit.resourcesPer100};}
  let military:Group[]=[];let militaryKey='';
  const refreshMilitary=async(state:GameState,facts:Awaited<ReturnType<typeof generate>>)=>{
    const key=hash({fleets:state.fleets.filter(f=>f.ownerId===actor),wars:state.wars,relations:state.relations,conquests:state.conquests,choice:state.factions[actor].civilization,shortages:state.factions[actor].shortages});
    if(key===militaryKey)return;militaryKey=key;audit.militaryPlanRefreshes++;
    const plans=militaryPlansV41(state,actor,facts,memory),available=CONFIG.tacticalPlans[profile]-report.v4!.tacticalEvaluations;
    const representatives=[...new Set(plans.map(p=>p.opponent+':'+p.warType+':'+p.mode))].map(k=>plans.find(p=>p.opponent+':'+p.warType+':'+p.mode===k)!);
    const chosen=[...representatives,...plans.filter(p=>!representatives.includes(p))].slice(0,Math.max(0,available));
    const t=performance.now(),evaluated=await Promise.all(chosen.map(option=>tactical(state,{actor,option})));stats.tacticalMs+=performance.now()-t;report.v4!.tacticalEvaluations+=evaluated.length;
    report.v4!.military.push(...evaluated);military=evaluated.map(p=>militaryActionV41(state,actor,p,facts)).filter((p):p is Group=>!!p);
    const old=memory.operation;
    if(old&&old.stage!=='exit') {
      const continuing=military.filter(c=>c.military?.opponent===old.opponent&&c.target===old.targets[0]).sort((a,b)=>b.value-a.value)[0];
      if(continuing)military=military.filter(c=>c.military?.mode==='defend'||c.military?.opponent===old.opponent&&c.target===old.targets[0]||c.value>=continuing.value*CONFIG.switchRatio);
    }
  };
  const candidatesFor=async(branch:Branch)=>{
    let cached=candidatesCache.get(branch.stage.draft);if(cached)return cached;
    const state=branch.stage.draft,facts=await factsFor(state);await refreshMilitary(state,facts);
    const all=[...military,...economyCandidatesV41(state,actor,facts.candidates.map(c=>({...c})),branch.projection)].map(c=>{
      const actions=c.actions.filter(a=>meaningful(state,actor,a));
      return actions.length===c.actions.length?c:{...c,actions,id:'v41:normalized:'+hash(actions)};
    });
    const seen=new Set(branch.groups.map(g=>g.id)),used=new Set(branch.groups.flatMap(g=>g.exclusive));
    cached=[...new Map(all.map(c=>[hash(c.actions),c])).values()].filter(c=>!seen.has(c.id)&&!c.exclusive.some(k=>used.has(k))&&c.actions.length&&c.actions.some(a=>meaningful(state,actor,a))).filter(c=>!memory.failures.some(f=>f.key===c.id&&f.fingerprint===v3FailureDependency(state,actor,c.actions,f.reason)));
    cached=cached.filter(c=>!rejections.has(branch.certificate.id+':'+c.id)).sort((a,b)=>b.priority-a.priority||b.value-a.value||a.id.localeCompare(b.id,'en'));
    candidatesCache.set(state,cached);return cached;
  };
  const reject=(parent:Branch,candidate:Group,reason:string)=>{pending.set(candidate.id,{candidate,reason});rejections.add(parent.certificate.id+':'+candidate.id);};
  const previewGroup=async(parent:Branch,candidate:Group):Promise<{stage:StagingArea;groups:Group[];hint:number}|null>=>{
    if(report.search!.evaluations>=phaseEvaluationLimit)return null;
    if(!admitted.has(candidate.id)&&admitted.size>=budget.candidates)return null;
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
    if(!hardAllowedV41(parent.certificate,child.certificate,strict))return false;
    const before=hardRiskV41(parent.certificate.windows),after=hardRiskV41(child.certificate.windows);
    return after<before-.001||child.certificate.value.total>parent.certificate.value.total+CONFIG.minimumGain;
  };
  const compare=(a:Branch,b:Branch)=>hardRiskV41(a.certificate.windows)-hardRiskV41(b.certificate.windows)||b.certificate.value.total-a.certificate.value.total||a.certificate.id.localeCompare(b.certificate.id,'en');
  const accept=(branch:Branch)=>{const added=branch.groups.slice(root.groups.length);branch.certificate.status='accepted';phaseStats[phase].actions+=branch.stage.actions.length-root.stage.actions.length;for(const c of added){audit.selectedGroups.push({id:c.id,phase,actions:c.actions.length});pending.delete(c.id);}root=branch;};
  const comboLimit=Math.floor((budget.evaluations-3)*(1-CONFIG.residualShare));
  const comboForecastLimit=budget.forecasts-CONFIG.repairForecasts-1-Math.ceil((budget.forecasts-1)*CONFIG.residualForecastShare);
  for(phase of ['combination','residual']) {
    const evaluationLimit=phase==='combination'?comboLimit:budget.evaluations-3;
    phaseEvaluationLimit=evaluationLimit;
    const forecastLimit=phase==='combination'?comboForecastLimit:budget.forecasts-CONFIG.repairForecasts;
    while(report.search!.evaluations<evaluationLimit&&root.stage.actions.length<actionLimit(world)) {
      await checkpoint();
      const all=(await candidatesFor(root)).filter(c=>!rejections.has(root.certificate.id+':'+c.id));if(!all.length)break;
      // Each category participates before a high-volume category can exhaust the shortlist.
      const heads=['crisis','military','economy'].flatMap(category=>all.filter(c=>phaseOf(c)===category).slice(0,Math.max(1,Math.floor(budget.width/3))));
      const shortlist=[...heads,...all.filter(c=>!heads.includes(c))].slice(0,Math.min(budget.width,evaluationLimit-report.search!.evaluations));
      const previews=(await Promise.all(shortlist.map(c=>previewGroup(root,c)))).filter((p):p is NonNullable<typeof p>=>!!p).sort((a,b)=>b.hint-a.hint||hash(a.stage.actions).localeCompare(hash(b.stage.actions),'en'));
      const choices:Branch[]=[];
      // Independently payable residual orders share a forecast without consuming one forecast per planet.
      if(phase==='residual'&&previews.length>1&&report.forecasts<forecastLimit) {
        let grouped={stage:root.stage,groups:root.groups};const used=new Set(root.groups.flatMap(g=>g.exclusive));
        for(const p of previews.slice(0,CONFIG.repairBatch)) {
          const c=p.groups.at(-1)!;if(c.military||['welfare','civilization','cancel'].includes(c.kind)||c.exclusive.some(k=>used.has(k)))continue;
          const proxy={...root,...grouped};const next=await previewGroup(proxy,c);if(next){grouped=next;for(const k of c.exclusive)used.add(k);}
        }
        if(grouped.groups.length>root.groups.length+1){const child=await makeProjection(grouped.stage,grouped.groups,forecastLimit);if(child&&improves(root,child))choices.push(child);}
      }
      let frontier:Branch[]=[];
      for(const p of previews) {
        const child=await makeProjection(p.stage,p.groups,forecastLimit);
        if(!child){reject(root,p.groups.at(-1)!,'详细预测额度已预留给独立任务及最终校验');continue;}
        frontier.push(child);report.search!.depth=Math.max(report.search!.depth,1);
        if(improves(root,child))choices.push(child);
        else {
          child.certificate.status='rejected';child.certificate.reason='同窗口生存风险或实际收益不优于当前已验证方案';
          reject(root,p.groups.at(-1)!,child.certificate.reason);
        }
      }
      // Expand dependent combinations to the selected profile's depth under the same round budget.
      for(let depth=2;phase==='combination'&&depth<=budget.depth&&frontier.length&&report.search!.evaluations<evaluationLimit&&report.forecasts<forecastLimit;depth++) {
        const nextFrontier:Branch[]=[];
        for(const parent of frontier.sort(compare).slice(0,budget.width)) {
          const related=parent.groups.slice(root.groups.length).flatMap(domains);
          const next=(await candidatesFor(parent)).filter(c=>domains(c).some(d=>related.includes(d))).slice(0,2);
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
      else for(const c of shortlist)reject(root,c,pending.get(c.id)?.reason??'已比较组合无可验证改善');
      if(!previews.length&&shortlist.every(c=>rejections.has(root.certificate.id+':'+c.id)))continue;
    }
  }
  phase='repair';report.v4.crisisChecked=true;
  // Every accepted prefix is already forecast-certified. Replaying the exact plan must reproduce it.
  const validate=hooks.validate??validateScriptPlan;
  const t=performance.now();let checked=validate(world,actor,root.stage.actions);report.validations=1;report.search!.evaluations++;
  while(!checked.ok&&report.validations<3) {
    const failed=root.stage.actions[checked.index],bad=root.groups.find(g=>g.actions.some(a=>JSON.stringify(a)===JSON.stringify(failed)));
    if(!bad)throw new Error('V4.1 无法归因最终校验失败，整轮暂停');
    const removed=new Set([bad.id]);let changed=true;while(changed){changed=false;for(const g of root.groups)if(!removed.has(g.id)&&root.certificate.dependencies[g.id]?.some(id=>removed.has(id))){removed.add(g.id);changed=true;}}
    audit.removed.push({id:bad.id,actions:bad.actions,reason:checked.reason,dependents:[...removed].filter(id=>id!==bad.id)});audit.rollbacks++;audit.repairs++;
    let retained=baseline;
    for(const g of root.groups.filter(g=>!removed.has(g.id))) {
      const stage=new StagingArea(retained.stage.draft,actor);stage.actions=[...retained.stage.actions];stage.trace=[...retained.stage.trace];
      for(const action of g.actions){const result=stage.execute(action.type,action.args);if(!result.ok)throw new Error('V4.1 独立动作重放失败，整轮暂停：'+result.error);}
      const next=await makeProjection(stage,[...retained.groups,g],budget.forecasts);
      if(!next)throw new Error('V4.1 风险修复额度不足，整轮暂停');
      if(improves(retained,next))retained=next;else audit.removed.push({id:g.id,actions:g.actions,reason:'依赖删除后边际风险或收益不再合格',dependents:[]});
    }
    if(root.groups.length&&!retained.groups.length)throw new Error('V4.1 最终校验无法保留有效计划，整轮暂停');
    root=retained;checked=validate(world,actor,root.stage.actions);report.validations++;report.search!.evaluations++;
  }
  stats.validationMs=performance.now()-t;
  if(!checked.ok)throw new Error('V4.1 三次原边界校验失败，整轮暂停：'+checked.reason);
  if(hash(checked.stage.draft)!==root.certificate.draftHash)throw new Error('V4.1 最终草稿与证书不一致，整轮暂停');
  root.certificate.status='final';audit.finalCertificate=root.certificate.id;audit.submittedGroups=root.groups.map(g=>g.id);audit.windows=root.certificate.windows;report.selectedProjection=root.certificate.id;
  for(const g of root.groups){report.selected.push({id:g.id,label:g.label,actions:g.actions,fingerprint:v3FailureDependency(world,actor,g.actions,'共同结算归属失败')});memory.tasks=memory.tasks.filter(t=>!g.tasks.some(n=>n.fleetId===t.fleetId));memory.tasks.push(...g.tasks);
    if(g.military&&g.military.mode!=='defend'){
      const option=g.military,prior=memory.operation as CampaignV41|undefined,war=activeWar(checked.stage.draft,actor,option.opponent),same=prior?.opponent===option.opponent&&prior.targets[0]===option.target;
      memory.operation={...(same?prior:{}),id:option.id,opponent:option.opponent,targets:[option.target],warType:option.warType,stage:g.kind==='war'?'attack':g.kind==='prepare'?'prepare':g.kind==='scout'?'recon':'assemble',fleetIds:option.fleetIds.filter(id=>checked.stage.draft.fleets.some(f=>f.id===id)),staging:option.staging,createdDay:same?prior!.createdDay:world.day,deadline:same?prior!.deadline:Math.min(endDay,option.expectedDay+600),progress:same?prior!.progress:'',lastProgressRound:same?prior!.lastProgressRound:world.round,value:option.value,reserve:{},blockers:option.blockers,nextStep:g.kind==='war'?'执行当前声明目标并检查控制、结算条件':'推进指定舰队和准备条件；两轮无进展重新比较',launchDay:option.ready?world.day:null,ready:option.ready,warId:war?.id,launchBy:Math.min(endDay-200,option.expectedDay),shipIds:checked.stage.draft.fleets.filter(f=>option.fleetIds.includes(f.id)).flatMap(f=>f.ships.map(s=>s.id))} as CampaignV41;
      memory.goal={id:option.id,kind:g.kind,target:option.target,stage:memory.operation.stage,value:option.value,prerequisites:option.blockers,deadline:memory.operation.deadline,progress:memory.operation.progress,lastProgressRound:memory.operation.lastProgressRound};
    }
  }
  const opportunities=[...pending.values()].filter(p=>!audit.submittedGroups.includes(p.candidate.id)).sort((a,b)=>b.candidate.value-a.candidate.value||a.candidate.id.localeCompare(b.candidate.id,'en'));
  const stop=checked.stage.actions.length>=48?'达到48条实际动作上限':report.search!.evaluations>=budget.evaluations-3?'草稿评估预算耗尽':report.forecasts>=budget.forecasts-CONFIG.repairForecasts?'预测预算耗尽；已认证动作全部保留':opportunities.some(p=>/资源|余额/.test(p.reason))?'资源受限；其余已比较机会无净收益':'已比较机会无净收益';
  audit.stopReasons=[...new Set([stop,...opportunities.slice(0,3).map(p=>p.reason)])];
  report.turn={revision:CONFIG.revision,actions:checked.stage.actions.length,planets:new Set(checked.stage.actions.map(a=>a.args.planetId).filter(Boolean)).size,stop,stages:phaseStats,opportunities:opportunities.slice(0,3).map(p=>({id:p.candidate.id,label:p.candidate.label,reason:p.reason,value:p.candidate.value})),value:{...root.certificate.value,governanceCost:root.certificate.value.softCost},welfareSafe:hardAllowedV41(baseline.certificate,root.certificate),threats:report.v4.military.filter(p=>p.mode==='defend')};
  report.v4.finalRisk={...root.certificate.windows.at(-1)!};report.v4.pending=opportunities.slice(0,32).map(p=>({id:p.candidate.id,reason:p.reason,dependency:root.certificate.id}));
  report.v4.stageBudgets=Object.fromEntries(Object.entries(phaseStats).map(([name,s])=>[name,{evaluations:s.evaluations,forecasts:s.forecasts,limit:name==='combination'?comboLimit:name==='residual'?budget.evaluations-3-comboLimit:3,forecastLimit:name==='combination'?comboForecastLimit:name==='residual'?budget.forecasts-CONFIG.repairForecasts-comboForecastLimit:CONFIG.repairForecasts}]));
  report.alternatives=opportunities.slice(0,3).map(p=>({id:p.candidate.id,label:p.candidate.label,priority:p.candidate.priority,value:p.candidate.value,risk:0,reason:p.reason,evidenceDays:p.candidate.evidenceDays,selected:false}));
  report.exhausted=stop.includes('预算');stats.peakRssMb=process.memoryUsage().rss/2**20;report.performance=stats;
  await hooks.inputAudit?.({revision:CONFIG.revision,boundaryHash,actor,profile,finalCertificate:root.certificate,operation:memory.operation});
  return {actions:checked.stage.actions,trace:checked.stage.trace,scriptMemory:memory,scriptReport:report,summary:`adaptive-v4.1 ${checked.stage.actions.length}条动作；${root.groups.slice(0,5).map(g=>g.label).join('；')}；${stop}`,metrics:{...emptyMetrics(),durationMs:performance.now()-started,reportedModel:'adaptive-v4.1'}};
}
