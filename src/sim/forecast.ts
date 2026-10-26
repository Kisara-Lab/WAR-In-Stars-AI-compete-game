import { applyExtractionRecovery } from './emergency.js';
import { responsible } from '../shared/responsibility.js';
import { previewDraft } from './preview.js';
import { modern, welfareRules, civilizationEligibility, welfareQuote } from '../shared/civilization.js';
import { policyComparison } from '../shared/comparison.js';
import { religionEligibility } from '../shared/religion-options.js';
import { freezeOperations } from '../shared/industry.js';
import type { GameState } from '../shared/types.js';
import { controller } from '../shared/v4.js';
import { economyFactors, mergePhase, settleEconomy } from './engine.js';
import { processLocal } from './local.js';
import { trackCivilization } from './civilization.js';
import { finishBalanceInterval } from './balance.js';
import { updatePolicies } from './policies.js';
import { applyAction } from './actions.js';

/** Economic projection: no combat, movement, new orders or foreign assets. Always a private draft. */
export function economicForecast(original: GameState, actor: string) {
  const state = previewDraft(original);
  state.config.factionIds = [actor];
  state.factions = { [actor]: state.factions[actor] };
  state.systems = state.systems.filter(s=>s.ownerId===actor || controller(s)===actor).map(s=>({ ...s, projects: s.projects.filter(p=>p.ownerId===actor && !['survey','base'].includes(p.kind)) }));
  state.fleets = state.fleets.filter(f=>f.ownerId===actor).map(f=>({...f, order:null, systemId:state.systems.some(s=>s.id===f.systemId&&controller(s)===actor)?f.systemId:null}));
  state.relations = Object.fromEntries(Object.entries(state.relations).filter(([,r])=>r.factions.includes(actor)));
  state.events=[];
  // Public rights remain frozen; foreign populations, ships, economic state and decisions are absent.
  const start = state.day, result: unknown[] = [], completedProjects: {id:string;day:number;kind:string}[]=[];
  let shortageDays=0, unpaidDays=0;
  for (let step=0;step<144;step++) {
    const beforeProjects=state.systems.flatMap(s=>s.projects);
    freezeOperations(state);
    const controlled=Object.fromEntries(state.systems.map(s=>[s.id,controller(s)]));
    state.day+=10;
    const factors=economyFactors(state);
    for (const phase of ['advance','economy'] as const) {
      if(phase==='economy'&&modern(state)) factors[actor].welfareQuote=welfareQuote(state,actor,10);
      const output=processLocal({ phase, day:state.day, seed:state.config.seed, systems:state.systems.filter(s=>controller(s)===actor), fleets:state.fleets.filter(f=>f.systemId), factions:factors, relations:state.relations, wars:state.wars });
      output.systems.push(...state.systems.filter(s=>controller(s)!==actor));
      mergePhase(state,phase,[output]);
      if(phase==='economy') settleEconomy(state,[output],factors,false);
    }
    if(modern(state)) trackCivilization(state,{[actor]:factors[actor].unity});
    applyExtractionRecovery(state);
    finishBalanceInterval(state,factors,controlled);
    updatePolicies(state);
    const remaining=new Set(state.systems.flatMap(s=>s.projects).map(p=>p.id));
    for(const p of beforeProjects) if(!remaining.has(p.id)) completedProjects.push({id:p.id,kind:p.kind,day:state.day});
    const faction=state.factions[actor];
    shortageDays+=Object.values(faction.shortages).some(Boolean)?10:0;
    unpaidDays+=modern(state)&&faction.welfare?.last?.fraction!==1?10:0;
    // Crisis is deliberately held fixed, not a forecast of future warfare or doctrine events.
    if(faction.faith) faction.faith.pending=[];
    if(step===71||step===143) result.push({days:state.day-start,resources:Object.fromEntries(Object.entries(faction.resources).map(([k,v])=>[k,v/1000])),unity:faction.unity/100,population:state.systems.flatMap(s=>s.planets).filter(p=>p.ownerId===actor).reduce((n,p)=>n+p.population,0),remainingProjects:state.systems.flatMap(s=>s.projects).map(p=>({id:p.id,kind:p.kind,progressDays:p.progress/1000})),shortageDays,unpaidDays,policy:faction.policy?.choice});
    state.events=[];
  }
  return {...(responsible(original)?{responsibilityAssumption:'未来责任压力与外国履约固定为当前状态；不假设战争成果或提案成功，援助出资方不假设未知余额返还'}:{}),assumptions:'只推进本国已知已付款项目、人口、经济及已提交政策；控制权、战争负担、信仰危机与对外关系冻结。无新订单、无未知敌军、无战争胜利假设；供应、队列及未来战争可能改变结果。航道舰船保持航道维护。', completedProjects, horizons:result};
}

export function pathwayForecasts(state:GameState,actor:string) {
  const policies=policyComparison(state,actor);
  const variants: {kind:string;choice:string;allowed:boolean;blocker:unknown;economy:unknown;projection:unknown;setup?:unknown;capability?:unknown}[]=[];
  variants.push({kind:'wait',choice:'retain_current',allowed:true,blocker:null,economy:policies.find(p=>p.choice===(state.factions[actor].policy?.choice??'none')),projection:economicForecast(state,actor),setup:'不承诺新路线，保留选择；已排队探索完成日见actionability，不预知圣地发现'});
  if(modern(state)) for(const choice of Object.keys(welfareRules(state)).filter(c=>c!=='church') as Exclude<keyof ReturnType<typeof welfareRules>,'church'>[]) {
    const draft=previewDraft(state),f=draft.factions[actor];
    let blocker:string|null=null;
    try {applyAction(previewDraft(state),actor,{type:'set_welfare',args:{welfare:choice}},'welfare-preview',false);}
    catch(e){blocker=e instanceof Error?e.message:String(e);}
    f.welfare!.choice=choice;delete f.welfare!.last;
    variants.push({kind:'welfare',choice,allowed:!blocker,blocker,economy:policyComparison(draft,actor,[f.policy?.choice??'none'])[0],projection:null,setup:'当前设施与人口的静态账单比较；不是建立永久文明或保证未来履约。制度锁定及冷却仍需满足'});
  }
  for(const p of policies.filter(p=>p.choice!==state.factions[actor].policy?.choice)) {
    const draft=previewDraft(state); draft.factions[actor].policy={term:Math.floor(state.day/720),choice:p.choice,explicit:true,locked:true};
    variants.push({kind:'policy',choice:p.choice,allowed:p.selectableNow,blocker:p.selectionBlocker,economy:p,projection:economicForecast(draft,actor)});
  }
  if(modern(state)&&state.factions[actor].civilization?.choice==='secular') for(const choice of ['utopia','militarist'] as const) {
    const draft=previewDraft(state),f=draft.factions[actor],eligibility=civilizationEligibility(state,actor,choice);
    f.civilization={choice,establishedDay:state.day};delete f.beacon;
    if(choice==='militarist'&&responsible(state)&&['utopian','welfare'].includes(f.welfare!.choice)){f.welfare!.choice='comfortable';delete f.welfare!.last;}
    if(choice==='utopia') {f.welfare!.choice='utopian';delete f.welfare!.last;}
    variants.push({kind:'civilization',choice,...(responsible(state)&&choice==='militarist'?{setup:{welfare:'comfortable',requiresExplicitWelfare:true}}:{}),allowed:eligibility.allowed,blocker:eligibility.blockers,economy:policyComparison(draft,actor,[f.policy?.choice??'none'])[0],projection:economicForecast(draft,actor),capability:choice==='militarist'?{fleetAndBasePower:1.10,shipyardProgress:1.15,shipMaintenance:1.10,example:'同等修正下100基础船体对应110战力；不代表必胜。提高既有舰船效率，但相同舰船材料成本不变',preparation:{days:180,minerals:150,food:50,unity:5}}:{populationGrowth:1.15,positiveUnity:2,condition:'须福利足额兑现及基础供应正常'}});
  }
  if(modern(state)&&state.factions[actor].civilization?.choice==='secular') {
    const candidates=state.systems.filter(s=>state.factions[actor].surveyed.includes(s.id)).flatMap(s=>s.planets.filter(p=>p.holyCandidate));
    const candidate=candidates.find(p=>p.ownerId===actor&&p.population>0&&state.systems.some(s=>s.planets.some(q=>q.id===p.id)&&s.ownerId===actor&&controller(s)===actor)&&!religionEligibility(state,actor,p.id))??candidates.find(p=>!religionEligibility(state,actor,p.id))??candidates[0];
    const blocker=candidate?religionEligibility(state,actor,candidate.id):'尚未探索发现圣地候选；不假设未来发现或夺取圣地';
    const draft=previewDraft(state),f=draft.factions[actor];
    f.civilization={choice:'theocracy',establishedDay:state.day};
    f.welfare={choice:'church',selectedDay:state.day,highestSince:null,history:[],firstChoice:false};
    f.faith={name:'国教成本预览',doctrine:'只读假设，非公开立教声明',establishedDay:state.day,crisis:0,sites:candidate?[{main:true,planetId:candidate.id,lossKeys:[],recoveryKeys:[]}]:[],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
    variants.push({kind:'civilization',choice:'theocracy',allowed:!blocker,blocker,economy:policyComparison(draft,actor,[f.policy?.choice??'none'])[0],projection:candidate?economicForecast(draft,actor):null});
    if(candidate&&!blocker) {
      const prepared=previewDraft(state);
      try {
        applyAction(prepared,actor,{type:'establish_religion',args:{planetId:candidate.id,name:'只读国教预览',doctrine:'模拟已知条件与真实费用，不产生生产局历史',acknowledgePermanent:true}},'preview-faith',false);
        applyAction(prepared,actor,{type:'consecrate',args:{planetId:candidate.id}},'preview-consecrate',false);
        variants.push({kind:'civilization_setup',choice:'theocracy_consecrated',allowed:true,blocker:null,economy:policyComparison(prepared,actor,[f.policy?.choice??'none'])[0],projection:economicForecast(prepared,actor),setup:{planetId:candidate.id,minerals:200,food:100,days:300,benefit:'实际扣费排队祝圣，300日完成后才计算社会协作；冻结控制，不假设征服成功'}});
      } catch(error) {variants.push({kind:'civilization_setup',choice:'theocracy_consecrated',allowed:false,blocker:error instanceof Error?error.message:String(error),economy:null,projection:null,setup:{planetId:candidate.id,minerals:200,food:100,days:300,requirement:'须己方法理拥有、实际控制、已有殖民地；不假设未来夺取或殖民'}});}
    }
  }
  return {assumption:'各组独立草稿，不修改真实世界。立即路线仅为静态假设，不绕过窗口或资格；祝圣方案仅在已知己方殖民地可执行时在草稿真实扣费并推进工期。未来政策不自动续期，未达标乌托邦不预测建国成功。',variants};
}
