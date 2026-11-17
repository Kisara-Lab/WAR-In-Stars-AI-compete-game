import type { GameState } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { ContinuityTaskV415Final } from '../shared/adaptive-v415final.js';
import { civilizationEligibility, CIVILIZATION, route } from '../shared/civilization.js';
import { policyComparison } from '../shared/comparison.js';
import { welfareRules } from '../shared/civilization.js';
import { welfarePackagesV415Final } from './adaptive-v415final-economy.js';

export function responsibilityPackages(state:GameState,actor:string,candidates:ScriptCandidate[]) {
  const packages=welfarePackagesV415Final(state,actor,candidates);
  const prerequisites=new Map<string,ScriptCandidate>();
  for(const group of packages)for(const action of group.actions.filter(action=>action.type==='build_structure')) {
    const original=candidates.find(candidate=>candidate.actions.length===1&&JSON.stringify(candidate.actions[0])===JSON.stringify(action));
    if(original)prerequisites.set(original.id,{...original,reason:original.reason+'；待遇兑现前置产能，若整组暂不可支付可先投资，不提前认领制度收益'});
  }
  return [...packages,...prerequisites.values()];
}

export function responsibilityTasks(state:GameState,actor:string,memory:ScriptMemory):ContinuityTaskV415Final[] {
  const own=state.factions[actor],end=state.day+(state.config.maxRounds-state.round)*100;
  const quote=policyComparison(state,actor,[own.policy?.choice??'none'])[0];
  const welfare=welfareRules(state),current=welfare[own.welfare?.choice??'comfortable'];
  const population=state.systems.flatMap(system=>system.planets).filter(planet=>planet.ownerId===actor).reduce((total,planet)=>total+planet.population,0);
  const funding=Object.fromEntries((['energy','food','minerals'] as const).map(resource=>[resource,Math.max(0,population*(welfare.utopian[resource]-current[resource])-quote.net[resource])]));
  const kind=route(state,actor),eligible=civilizationEligibility(state,actor,'utopia');
  const blockers=kind==='secular'?eligible.blockers:own.responsibility?.ignored?['存在尚未实际履行的救援责任']:[];
  const evidence=JSON.stringify({kind,qualified:own.welfare?.history.filter(item=>item.qualified).length??0,shortages:own.shortages,paid:own.welfare?.last?.fraction,responses:own.responsibility?.responses,awarded:own.responsibility?.awardedWars});
  const id='responsibility:'+kind,old=memory.v415final?.tasks?.find(task=>task.id===id);
  const progressed=!old||old.evidence!==evidence;
  const lastProgressRound=progressed?state.round:old.lastProgressRound;
  const deadline=own.extraction?.expiresDay??(kind==='secular'?Math.max(state.day,(own.welfare?.highestSince??state.day)+CIVILIZATION.qualificationDays):end);
  return [{id,target:actor,kind:'responsibility',createdRound:old?.createdRound??state.round,lastProgressRound,expectedDay:Math.min(end,deadline),status:state.round-lastProgressRound>=2?'reassess':blockers.length?'blocked':'active',evidence,blockers,funding,dependencies:state.systems.flatMap(system=>system.projects.filter(project=>project.ownerId===actor&&project.kind==='building').map(project=>project.id)),outcome:kind==='secular'?'真实满足制度资格；仍需独立比较永久承诺':'实际供给、监督与责任结算',next:Object.values(funding).some(value=>value>0)?'比较基础产能前置投资与保持当前待遇':kind==='secular'&&!eligible.allowed?'维持足额待遇并积累真实资格，比较其他制度路径':kind==='secular'?'比较合法永久制度与继续世俗':'按实际责任及截止日执行援助、监督或成果结算'}];
}
