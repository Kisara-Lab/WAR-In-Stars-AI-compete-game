import type { ScriptMemory } from '../shared/adaptive.js';
import type { CampaignV412 } from '../shared/adaptive-v412.js';
import type { GameState } from '../shared/types.js';
import type { CertificateV412, MilitaryOptionV412, NationalPlanV412 } from '../shared/adaptive-v412.js';
import { policyComparison } from '../shared/comparison.js';
import { governanceView } from '../shared/governance.js';
import { constructionView } from '../shared/construction.js';
import { fleetPower } from './math.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { shipMaterials } from '../shared/industry.js';
import { SHIPS } from '../shared/rules.js';

/** These envelopes guide admission and reserve unpaid military orders; forecasts
 * still decide whether any actual action should be accepted. */
export function strategicEnvelopeV412(state:GameState,actor:string,memory:ScriptMemory,certificate:CertificateV412,military:MilitaryOptionV412[],candidates:ScriptCandidate[]) {
  const near=certificate.windows.find(w=>w.days>=300)??certificate.windows[0];
  const crisis=near.shortageDays>0||(near.causes?.fundingSeverity??0)>0;
  const current=memory.operation as CampaignV412|undefined;
  const plans=military.filter(p=>p.value>0&&!p.eliminated).sort((a,b)=>Number(b.holding)-Number(a.holding)||Number(b.mode==='defend')-Number(a.mode==='defend')||b.value-a.value||a.id.localeCompare(b.id));
  const continuing=plans.find(p=>p.opponent===current?.opponent&&p.target===current.targets[0]);
  const selected=continuing&&(!current?.reassess||continuing.value*1.2>=(plans[0]?.value??0))?continuing:plans[0];
  const economy=Math.max(0,...candidates.filter(c=>['build','ships','colonize','base'].includes(c.kind)).map(c=>c.value));
  const kind:NationalPlanV412['kind']=crisis?'recover':selected?.mode==='defend'?'defend':selected&&(selected.holding||continuing||selected.value>economy)?'campaign':'develop';
  const missing=kind==='campaign'||kind==='defend'?Math.max(0,selected?.shortPower??0):0;
  const cost=shipMaterials('destroyer'),count=Math.ceil(missing/SHIPS.destroyer.power);
  const reserve=Object.fromEntries(['energy','food','minerals','alloys'].map(r=>[r,Math.min((state.factions[actor].resources[r as keyof typeof cost]??0)/1000,(cost[r as keyof typeof cost]??0)/1000*count)]));
  return {kind,selected,reserve,alternatives:[{kind:'continue',value:continuing?.value??0,reason:'保留有效现有任务，检查实际进展'},{kind:'recover',value:near.shortageDays*20+(near.causes?.fundingSeverity??0)*20,reason:'按可恢复供应和资金缺口比较'},{kind:'develop',value:economy,reason:'所有行星轻量筛选后的投资机会'},...plans.slice(0,3).map(p=>({kind:p.mode==='defend'?'defend':'campaign',value:p.value,reason:p.opponent+'/'+p.target+'；'+p.variant}))]};
}

/** Only reconcile wars involving this actor; unrelated world wars never enter memory. */
export function reconcileWarV412(state:GameState,actor:string,memory:ScriptMemory) {
  if(memory.version!=='adaptive-v4.12'||!memory.operation)return;
  const operation=memory.operation as CampaignV412;
  const actual=state.wars?.find(war=>war.endedDay===undefined&&war.factions.includes(actor)&&war.factions.includes(operation.opponent)&&war.type===operation.warType&&(war.type==='total'||war.goals[actor]?.some(goal=>!goal.invalid&&operation.targets.includes(goal.systemId))));
  if(!actual)return;
  const predictedId=operation.warId;
  operation.warId=actual.id;
  for(const task of memory.tasks)if(task.campaignId===operation.id||predictedId&&task.warId===predictedId)task.warId=actual.id;
  if(operation.completed&&operation.exitReason==='关联战争已结算'){
    operation.completed=false;delete operation.exitReason;operation.stage='attack';
    operation.nextStep='按本方实际战争继续检查声明目标、控制和结算条件';
  }
}

/** Real observations only; no observer ranking or opponent economic state. */
export function feedbackV412(state:GameState,actor:string,memory:ScriptMemory) {
  const record=memory.v412??={feedback:[],reactions:[]};
  const prior=record.expected,own=state.factions[actor];
  if(prior&&prior.round===state.round) {
    const add=(kind:string,expected:number,actual:number,reason:string)=>{
      if(Math.abs(expected-actual)>.01)record.feedback.push({round:state.round,kind,expected,actual,reason});
    };
    add('unity',prior.unity,own.unity/100,'核对待遇、责任、供应与实际战损');
    add('quality',prior.quality,governanceView(state,actor).quality,'核对资金支付、交付阻断和治理采样');
    for(const key of ['energy','minerals','food','alloys'] as const)add(key,prior.resources[key]??0,(own.resources[key]??0)/1000,'核对实际完工、停产、占领和付款');
    const alive=new Set(state.fleets.filter(f=>f.ownerId===actor).flatMap(f=>f.ships.map(s=>s.id)));
    add('survivingAssignedShips',prior.ships.length,prior.ships.filter(id=>alive.has(id)).length,'实际舰船损失；重新比较主力与支援需求');
  }
  record.feedback=record.feedback.slice(-24);
  for(const [systemId,intel] of Object.entries(own.militaryIntel??{})) {
    if(intel.day<state.day-200)continue;
    for(const opponent of [...new Set(intel.fleets.filter(f=>f.ownerId!==actor).map(f=>f.ownerId))]) {
      const power=intel.fleets.filter(f=>f.ownerId===opponent).reduce((n,f)=>n+fleetPower(f),0);
      const previous=record.reactions.find(r=>r.opponent===opponent&&r.systemId===systemId);
      if(previous&&previous.day>=intel.day)continue;
      record.reactions=record.reactions.filter(r=>r.opponent!==opponent||r.systemId!==systemId);
      record.reactions.push({opponent,systemId,day:intel.day,power,source:intel.source});
    }
  }
  record.reactions=record.reactions.filter(r=>state.day-r.day<=1440).slice(-32);
}

export function nationalPlanV412(state:GameState,actor:string,memory:ScriptMemory,groups:(ScriptCandidate&{military?:MilitaryOptionV412})[],certificate:CertificateV412,baseline:CertificateV412):NationalPlanV412 {
  const own=state.factions[actor],quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const old=memory.v412?.national,operation=memory.operation as CampaignV412|undefined;
  const categories=new Map<NationalPlanV412['kind'],number>([['continue',0]]);
  for(const g of groups) {
    const kind=g.military?g.military.mode==='defend'?'defend':'campaign':['recovery','faith','aid','reform','settle'].includes(g.kind)?'recover':'develop';
    categories.set(kind,(categories.get(kind)??0)+Math.max(0,g.value));
  }
  const kind=operation&&operation.stage!=='exit'?'campaign':([...categories].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]??'continue');
  const deadline=operation&&operation.stage!=='exit'?operation.deadline:Math.min(state.day+720,state.day+(state.config.maxRounds-state.round)*100);
  const days=Math.min(300,Math.max(0,deadline-state.day));
  const reserve=Object.fromEntries(['energy','food','minerals','alloys'].map(r=>[r,Math.max(0,(quote.upkeep[r as keyof typeof quote.upkeep]??0)*days/100)]));
  const projects=state.systems.flatMap(s=>s.projects.filter(p=>p.ownerId===actor).map(p=>p.id));
  const target=operation&&operation.stage!=='exit'?operation.targets[0]:'national';
  const changed=groups.length>0;
  return {id:kind+':'+target,kind,target,reason:kind==='campaign'?'以夺取、守住和兑现整段战役分配经营与军备':kind==='recover'?'按资金、供应、责任和交付原因分别恢复':'按实际得分与可兑现用途安排全国经营',nextStep:operation&&operation.stage!=='exit'?operation.nextStep:groups.at(-1)?.label??'等待已付款项目或前提变化；保留未评估机会',completion:kind==='campaign'?'实际战争成果结算，或明确退出并释放资源':'预测缺口消失或已选生产/投资实际完成',deadline,lastProgressRound:changed?state.round:old?.lastProgressRound??state.round,reserve,projects,ships:operation?.shipIds??[],dependencies:groups.flatMap(g=>g.exclusive),value:certificate.value.total-baseline.value.total,alternatives:[...categories].map(([kind,value])=>({kind,value,reason:kind==='continue'?'保持现有资产、责任与已付款队列':'已进入候选比较；数值为轻量筛选，最终按前缀预测选择'}))};
}

export function paidReinforcementsV412(state:GameState,actor:string) {
  return state.systems.filter(s=>s.ownerId===actor).flatMap(system=>system.planets.filter(p=>p.ownerId===actor).flatMap(planet=>{
    const queue=constructionView(state,system,planet).queues.flatMap(q=>q.projects);
    return system.projects.filter(p=>p.planetId===planet.id&&p.ownerId===actor&&p.kind==='ship'&&p.shipType).flatMap(project=>{
      const completeDay=queue.find(q=>q.id===project.id)?.estimatedCompleteDay;
      return completeDay===null||completeDay===undefined?[]:[{id:project.id,systemId:system.id,shipType:project.shipType!,completeDay}];
    });
  }));
}
