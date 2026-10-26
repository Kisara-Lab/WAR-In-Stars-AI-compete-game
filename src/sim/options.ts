import { emergencyEconomy } from './emergency-comparison.js';
import { shortestPath } from './math.js';
import { RULES } from '../shared/rules.js';
import { governed, governanceView, actionLimit } from '../shared/governance.js';
import { settlementPreview } from '../shared/settlement-preview.js';
import { responsible, responsibilityView } from '../shared/responsibility.js';
import { dutyPaths, rescueReasons } from './social.js';
import { previewDraft } from './preview.js';
import { CIVILIZATION, modern, civilizationView } from '../shared/civilization.js';
import { industryComparison, resourcePurposes } from './industry.js';
import { actionability } from './actionability.js';
import { economicForecast, pathwayForecasts } from './forecast.js';
import { industrial } from '../shared/industry.js';
import { BALANCE, balancedRules, warBurden } from '../shared/balance.js';
import { balanceSummary } from '../shared/comparison.js';
import { warReasons } from '../shared/escalation.js';
import type { Action, GameState } from '../shared/types.js';
import { V4 } from '../shared/v4.js';
import { applyV4Action } from './v4-actions.js';

export function decisionComparison(state: GameState, actor: string, unified = true) {
  const check = (action: Action) => {
    try { applyV4Action(previewDraft(state), actor, action, 'comparison-only', false, true); return { allowed: true, blocker: null }; }
    catch (error) { return { allowed: false, blocker: error instanceof Error ? error.message : String(error) }; }
  };
  const faction = state.factions[actor];
  const knownFleets = new Map<string, {id:string;ownerId:string;systemId:string|null;lastSeenDay:number;hullPower:number}>();
  const remember=(fleet: import('../shared/types.js').Fleet,day:number)=> { if((knownFleets.get(fleet.id)?.lastSeenDay??-1)<=day) knownFleets.set(fleet.id,{id:fleet.id,ownerId:fleet.ownerId,systemId:fleet.systemId,lastSeenDay:day,hullPower:fleet.ships.reduce((n,s)=>n+s.hull,0)}); };
  for(const intel of Object.values(faction.intel)) for(const fleet of intel.fleets) remember(fleet,intel.day);
  for(const intel of Object.values(faction.militaryIntel??{})) for(const fleet of intel.fleets) remember(fleet,intel.day);
  for(const intel of Object.values(faction.transitIntel??{})) remember(intel.fleet,intel.day);
  if(governed(state)) for(const [id,fleet] of knownFleets) {
    if(!fleet.systemId)continue;
    const latest=[faction.intel[fleet.systemId],faction.militaryIntel?.[fleet.systemId]].filter((x): x is NonNullable<typeof x> => !!x).sort((a,b)=>b.day-a.day)[0];
    if(latest && latest.day>fleet.lastSeenDay && !latest.fleets.some(f=>f.id===id))knownFleets.delete(id);
  }
  const candidates = state.systems.filter(system => faction.surveyed.includes(system.id)).flatMap(system => system.planets.filter(planet => planet.holyCandidate).map(planet => ({ systemId: system.id, planetId: planet.id, ...check({ type: 'establish_religion', args: { planetId: planet.id, name: '候选评估', doctrine: '静态资格检查', acknowledgePermanent: true } }) })));
  const ownSystems = new Set(state.systems.filter(system => system.ownerId === actor).map(system => system.id));
  const known = state.systems.flatMap(system => {
    const intel = faction.intel[system.id]?.system;
    const military = faction.militaryIntel?.[system.id];
    const owner = governed(state) ? military && military.day >= (faction.intel[system.id]?.day ?? -1) ? military.ownerId : intel?.ownerId : military?.ownerId ?? intel?.ownerId;
    return owner ? [{ systemId: system.id, owner, border: system.neighbors.some(id => ownSystems.has(id)) }] : [];
  });
  const wars = Object.values(state.relations).filter(relation => relation.factions.includes(actor) && relation.status !== 'unknown').map(relation => {
    const target = relation.factions.find(id => id !== actor)!;
    const possibilities: Action[] = warReasons(state, actor).filter(reason => reason.target === target).map(reason => ({ type: 'declare_war', args: { factionId: target, warType: 'total', systemIds: [], grievanceId: reason.id, reason: '比较合法总体战入口' } }));
    for (const item of known.filter(item => item.owner === target && item.border || item.owner === actor)) for (const warType of ['limited', 'claim', 'missionary', 'ideological']) possibilities.push({ type: 'declare_war', args: { factionId: target, warType, systemIds: [item.systemId], grievanceId: null, reason: '比较有限目标' } });
    if(responsible(state)) for(const reason of rescueReasons(state,actor).filter(r=>r.target===target)) for(const item of known.filter(k=>k.owner===target&&k.border)) possibilities.push({type:'declare_war',args:{factionId:target,warType:'humanitarian',systemIds:[item.systemId],grievanceId:reason.id,reason:'humanitarian comparison'}});
    const current = warBurden(state, actor);
    const military = { fleets: [...knownFleets.values()].filter(f=>f.ownerId===target), targets: known.filter(k=>k.owner===target).map(k=>({systemId:k.systemId,base:governed(state)?(faction.militaryIntel?.[k.systemId]&&faction.militaryIntel[k.systemId].day>=(faction.intel[k.systemId]?.day??-1)?faction.militaryIntel[k.systemId].base:faction.intel[k.systemId]?.system.base):faction.militaryIntel?.[k.systemId]?.base??faction.intel[k.systemId]?.system.base,lastSeenDay:governed(state)?Math.max(faction.militaryIntel?.[k.systemId]?.day??-1,faction.intel[k.systemId]?.day??-1):faction.militaryIntel?.[k.systemId]?.day??faction.intel[k.systemId]?.day,localFleetIds:[...knownFleets.values()].filter(f=>f.ownerId===target&&f.systemId===k.systemId).map(f=>f.id)})), warning:'仅已知船体战力；本地守军与别处可能增援分列，外国修正与未知部队不推测，不是敌国总军力' };
    const extra = balancedRules(state) ? Math.min(1 + BALANCE.upkeepCap, current.multiplier + BALANCE.offensiveUpkeep) - current.multiplier : 0;
    return { ...(state.rulesRevision==='5.4'?{emergencyEconomy:emergencyEconomy(state,actor)}:{}), ...(governed(state)?{ remainingDays:(state.config.maxRounds-state.round)*100, reasons:warReasons(state,actor).filter(r=>r.target===target), religiousDutyOnly:responsible(state)?dutyPaths(state,actor):null, targetIntel:known.filter(k=>k.owner===target).map(k=>({systemId:k.systemId,colonyIntelDay:faction.intel[k.systemId]?.day??null,militaryIntelDay:faction.militaryIntel?.[k.systemId]?.day??null,travel:state.fleets.filter(f=>f.ownerId===actor&&f.systemId).map(f=>{const path=shortestPath(state.systems,f.systemId!,k.systemId);return {fleetId:f.id,hops:path?.length??null,minimumJumpDays:path?path.length*RULES.jumpDays:null,warning:'Public topology lower bound only; legal transit, local travel and current orders also constrain arrival'};}),unknownMilitary:true,refresh:'survey_system for exploration; move_fleet or staffed LRS for military only'})), pathSeparation:'Religious duty actionable=false does not prohibit ordinary wars, claims or conquest preparation. Evaluate each independent validator.' }:{}), target, military, status: relation.status, pactUntil: relation.pactUntil, preparation: check({ type: 'prepare_conquest', args: { factionId: target, reason: '比较主动征服准备' } }), options: possibilities.map(action => ({ ...action.args as {warType:string;systemIds:string[];grievanceId:string|null}, ...check(action) })), claims: known.filter(item=>item.owner===target&&item.border).map(item=>({systemId:item.systemId,...check({type:'create_claim',args:{systemId:item.systemId}}),costMinerals:100,earliestWarRound:state.round+1})), totalWarExtraPer100: { energy: current.base.energy * extra, minerals: current.base.minerals * extra, unity: balancedRules(state) ? -Math.min(1, Math.max(0, BALANCE.offensiveUnityCap - current.offensive)) : 0 }, rewardGuide: { limited: '不割地；基地停用300日、最多200矿物赔偿、去重目标50分', claim: '预先宣称1～2非母星目标；割让即正常生产，持有领土成果100/星系', missionary: '五年传教权，不割地；去重目标50分', ideological: '清除目标影响与传教权、1080日保护；去重目标50分', total: balancedRules(state) ? '可吞并及淘汰；720实际控制日整合，生产/建设/人口×0.5，维护全额，成果100分延迟至整合完成' : '可吞并及淘汰，无整合期，持有领土成果100/星系' } };
  });
  return { ...(state.rulesRevision==='5.4'?{emergencyEconomy:emergencyEconomy(state,actor)}:{}), ...(governed(state)?{ governance:governanceView(state,actor),actionLimit:actionLimit(state),validFleetIds:state.fleets.filter(f=>f.ownerId===actor).map(f=>f.id),dispute:{exists:!!faction.faith?.dispute,cooldownUntil:faction.faith?.response?.cooldownUntil??null},settlementPreview:(state.wars??[]).filter(w=>w.factions.includes(actor)&&w.endedDay===undefined).map(w=>settlementPreview(state,actor,w)) }:{}), ...balanceSummary(state, actor), ...(responsible(state)?{responsibilities:{...responsibilityView(state,actor),paths:dutyPaths(state,actor),rescueReasons:rescueReasons(state,actor)}}:{}), ...(modern(state) ? { institutions: civilizationView(state,actor) } : {}), ...(unified && industrial(state) ? { actionability:actionability(state,actor), resourcePurposes:resourcePurposes(state,actor), industry:industryComparison(state,actor), forecast:economicForecast(state,actor), pathwayForecasts:pathwayForecasts(state,actor), marginalResources: { energy:'维护、福利及生产保障；无直接库存分，充足后新增电力边际收益下降',food:'人口、福利、殖民和祝圣；无直接库存分',minerals:'维护、福利、冶炼、建设；矿物+2合金储备分最多400，封顶后须比较实际用途',alloys:'舰船、维修和轨道设施；已排队舰船预付材料，不需重复备料' } } : {}), wars, religion: { candidates, permanent: '永久国教及固定主圣地，永远禁用乌托邦；名称和教义不产生额外能力', immediate: V4.faithTiers[0], afterConsecration: modern(state) ? '教廷保障锁定；安全主圣地且危机<20，全国资源产出×1.10；主圣地当前200分；福利足额及稳定信仰合格任期100分' : balancedRules(state) ? '安全主圣地且危机<20，全国资源产出×1.05；主圣地当前200分；合格完整任期100分' : '主圣地首次祝圣危机-5；无文明分或额外经济加成', tiers: V4.faithTiers, risks: { mainLoss: V4.mainLoss, secondaryLoss: V4.secondaryLoss, explanation: '伤亡、已祝圣圣地失守及争端驱动危机；未祝圣不承担失守惩罚；持续胜利与正常供应不强制触发危机' }, scoring: balancedRules(state) ? '乌托邦与稳定信仰每合格720日任期100分；稳定信仰需整届国教、至少90%区间供应正常/危机<20/主圣地安全；共享1500分上限，不追补历史' : '此旧修订不含文明成果分' }, validation: '与实际命令共用校验；只使用己方可知情报，隐藏变化在共同结算复核；比较不执行命令' };
}
