import { CIVILIZATION, CIVILIZATION_NAMES, WELFARE, civilizationEligibility, initializeCivilization, modern, route, welfareQuote } from '../shared/civilization.js';
import { assignEarlyHolyCandidates, discoverHoly } from './religion.js';
import { refreshIntel } from './intel.js';
import type { WelfareId } from '../shared/civilization.js';
import type { Action, GameState, Resources, Shortages } from '../shared/types.js';
import { RULES } from '../shared/rules.js';
import { v4Event } from '../shared/v4.js';
import { awardCivilization } from './balance.js';
import { migrateIndustry } from './industry.js';
import { responsible, decisionBalanced, newResponsibility } from '../shared/responsibility.js';
import { assignFoundingCandidates } from './founding.js';
import { aidedWelfare, initializeSocial, liveReform, breach } from './social.js';

export function applyCivilization(state: GameState, actor: string, action: Action) {
  if (!modern(state)) throw new Error('此工具仅适用于V5');
  const f = state.factions[actor], w = f.welfare!;
  if (action.type === 'set_welfare') {
    const choice = action.args.welfare as WelfareId;
    if (!(choice in WELFARE) || choice === 'church') throw new Error('世俗待遇必须选择五档之一');
    if (['utopia', 'theocracy'].includes(route(state, actor))) throw new Error('永久制度锁定民众待遇');
    if (responsible(state)&&route(state,actor)==='militarist'&&!['comfortable','basic','survival'].includes(choice)) throw Error('军国仅允许均衡小康、基础保障、维持生存');
    if (responsible(state)&&['basic','survival'].includes(choice)&&state.social?.aid.some(a=>a.target===actor&&a.acceptedDay!==undefined&&a.endedDay===undefined&&a.expiresDay>state.day)) throw Error('接受援助的360日承诺要求至少均衡小康');
    if (!w.firstChoice && state.day < w.selectedDay + CIVILIZATION.welfareCooldown) throw new Error(`待遇锁定至第${w.selectedDay + CIVILIZATION.welfareCooldown}日`);
    if (!w.firstChoice && w.choice === choice) throw new Error('待遇已经采用，无需重复选择');
    w.highestSince = choice === 'utopian' ? (w.choice === choice ? w.highestSince ?? state.day : state.day) : null;
    if (w.choice !== choice) w.history = [];
    w.choice = choice; w.firstChoice = false; w.selectedDay = state.day;
    if(responsible(state)&&['basic','survival'].includes(choice)){const agreement=liveReform(state,actor);if(agreement)breach(state,agreement,'主动降低至第四或第五档待遇');}
    v4Event(state, 'beacon', `${f.name}选择民众待遇：${WELFARE[choice].name}，锁定360日`, [actor], { action, nextDay: state.day + CIVILIZATION.welfareCooldown });
    return { choice, lockedUntil: state.day + CIVILIZATION.welfareCooldown };
  }
  const choice = action.args.civilization as 'utopia' | 'militarist';
  if (!['utopia','militarist'].includes(choice) || action.args.acknowledgePermanent !== true) throw new Error('须明确确认有效文明路线的永久后果');
  const eligibility = civilizationEligibility(state, actor, choice);
  if (!eligibility.allowed) throw new Error(eligibility.blockers.join('；'));
  if(responsible(state)&&choice==='militarist'){
    const selected=action.args.welfare as WelfareId|null|undefined;
    if(!['comfortable','basic','survival'].includes(w.choice)&&!selected)throw Error('建立军国须同时明确选择合法待遇 welfare=comfortable/basic/survival');
    if(selected){if(!['comfortable','basic','survival'].includes(selected))throw Error('军国待遇只能选择第三至第五档');if((liveReform(state,actor)||state.social?.aid.some(a=>a.target===actor&&a.acceptedDay!==undefined&&a.endedDay===undefined&&a.expiresDay>state.day))&&selected!=='comfortable')throw Error('改革或已接受援助期间须至少均衡小康，不能通过建立军国绕过承诺');w.choice=selected;w.selectedDay=state.day;w.firstChoice=false;w.highestSince=null;w.history=[];}
  }
  if(responsible(state))f.responsibility=newResponsibility(state.day);
  f.civilization = { choice, establishedDay: state.day, historyBeacon: f.civilization?.historyBeacon };
  if (choice === 'utopia') { w.choice = 'utopian'; w.firstChoice = false; }
  f.beacon = { term: Math.floor(state.day / 720), totalDays: 0, suppliedDays: 0, disqualified: state.day % 720 !== 0, streak: 0, highest: 0 };
  v4Event(state, 'beacon', `${f.name}永久确立${CIVILIZATION_NAMES[choice]}`, [actor], { action, permanent: true, welfare: w.choice });
  return { choice, permanent: true };
}

/** Only main-thread settlement spends resources. Welfare is added to upkeep once. */
export function settleWelfare(state: GameState, actor: string, income: Resources, upkeep: Resources, frozenQuote?: ReturnType<typeof welfareQuote>) {
  const f = state.factions[actor], w = f.welfare!, quote = frozenQuote ?? welfareQuote(state, actor, RULES.tickDays);
  const keys = ['energy', 'minerals', 'food'] as const;
  const baseShortages = Object.fromEntries(keys.map(k => [k, f.resources[k] + income[k] < upkeep[k]])) as unknown as Shortages;
  const bottlenecks=keys.filter(k=>Math.max(0,f.resources[k]+income[k]-upkeep[k])<quote.deliverable[k]);
  const ratio = Math.min(1, ...keys.map(k => quote.deliverable[k] ? Math.max(0, f.resources[k] + income[k] - upkeep[k]) / quote.deliverable[k] : 1));
  const aidResult=responsible(state)?aidedWelfare(state,actor,Object.fromEntries(keys.map(k=>[k,Math.max(0,f.resources[k]+income[k]-upkeep[k])])) as unknown as Resources,quote.deliverable):null;
  const paid: Resources = aidResult?.paid??{ energy: 0, minerals: 0, food: 0 };
  for (const k of keys) { if(!aidResult)paid[k] = Math.floor(quote.deliverable[k] * ratio); upkeep[k] += aidResult?.selfPaid[k]??paid[k]; }
  const fraction = quote.population ? Math.min(...keys.map(k => quote.due[k] ? paid[k] / quote.due[k] : 1)) : 1;
  const previous = w.last?.fraction;
  if(responsible(state)&&quote.rounding)w.rounding=structuredClone(quote.rounding);
  w.last = { day: state.day, ...quote, paid, fraction, ...(aidResult?{aid:aidResult.aidPaid,selfPaid:aidResult.selfPaid}:{}), reasons: [...(quote.reachablePopulation < quote.population ? ['占领区无法交付'] : []), ...(decisionBalanced(state)?bottlenecks.filter(k=>paid[k]<quote.deliverable[k]):keys.filter(k => paid[k] < quote.deliverable[k])).map(k => `${k}福利预算不足`)] };
  if (previous !== undefined && (previous === 1) !== (fraction === 1)) v4Event(state, 'beacon', `${f.name}福利${fraction === 1 ? '恢复足额兑现' : '失约，条件奖励暂停'}`, [actor], w.last);
  if (f.faith && fraction < 1) f.faith.pending.push({ reason: '教廷保障失约', amount: CIVILIZATION.religiousBrokenPromise * (1-fraction) * RULES.tickDays / 100, source: `welfare:${state.day}` });
  return baseShortages;
}

export function trackCivilization(state: GameState, previousUnity: Record<string, number>) {
  if (!modern(state)) return;
  const term = Math.floor((state.day - RULES.tickDays) / 720);
  for (const [actor, f] of Object.entries(state.factions)) {
    if (f.eliminatedDay !== undefined) continue;
    const w = f.welfare!;
    const qualified = w.choice === 'utopian' && w.last?.fraction === 1 && !Object.values(f.shortages).some(Boolean) && previousUnity[actor] >= 8000;
    w.history.push({ day: state.day, qualified });
    w.history = w.history.filter(h => h.day > state.day - 720);
    if (route(state, actor) !== 'utopia') continue;
    const b = f.beacon ??= { term, totalDays: 0, suppliedDays: 0, disqualified: state.day - RULES.tickDays !== term * 720, streak: 0, highest: 0 };
    b.totalDays += RULES.tickDays;
    if(responsible(state)&&f.responsibility?.ignored)b.disqualified=true;
    if (qualified) b.suppliedDays += RULES.tickDays;
    if (state.day % 720) continue;
    const passed = !b.disqualified && b.totalDays === 720 && b.suppliedDays / 720 >= CIVILIZATION.qualificationFraction;
    if (passed) awardCivilization(state, actor, 'utopia', term, { ...b, criterion: '最高福利兑现/供应/凝聚力；参战不失格' });
    b.streak = passed ? b.streak + 1 : 0; b.highest = Math.max(b.highest, Math.min(2, Math.max(0,b.streak-1)));
    v4Event(state, 'beacon', `${f.name}乌托邦民生评估${passed ? '合格' : '未合格'}，连续${b.streak}期`, [actor], { ...b, passed });
    b.term = term + 1; b.totalDays = 0; b.suppliedDays = 0; b.disqualified = false;
  }
}

export function migrateCivilization(original: GameState): GameState {
  if (modern(original)) return structuredClone(original);
  if (original.result) throw new Error('已结束比赛不能迁移继续运行');
  const state = migrateIndustry(original);
  state.version = 5; state.rulesRevision = '5.0';
  for (const actor of Object.keys(state.factions)) {
    const f = state.factions[actor], previousPolicy = structuredClone(f.policy);
    initializeCivilization(state, actor, true);
    f.policy = { term: Math.floor(state.day / 720), choice: 'none', explicit: false, locked: true };
    delete f.beacon; delete f.stableFaith;
    v4Event(state, 'beacon', `${f.name}迁移V5：终止旧政策与预约，未追补制度资格或福利物资`, [actor], { previousPolicy, civilization: f.civilization, welfare: f.welfare });
  }
  return state;
}

export function migrateResponsibilities(original: GameState): GameState {
  if(original.result)throw Error('已结束比赛不能迁移继续运行');
  if(responsible(original))return structuredClone(original);
  const faithful=Object.entries(original.factions).filter(([,f])=>!!f.faith);
  if(faithful.length>2)throw Error('5.2仅有两个创教资格；原局超过两个国教，无法兼容迁移，请保留原规则');
  const state=migrateCivilization(original),pinned=faithful.map(([,f])=>f.faith!.sites.find(s=>s.main)!.planetId);
  if(!assignFoundingCandidates(state.systems,Object.values(state.factions).map(f=>f.homeSystemId),state.config.seed,pinned))throw Error('旧地图无法保留主圣地并补足两个合格创教候选，未创建分支');
  state.rulesRevision='5.2';initializeSocial(state);
  state.social!.founders=faithful.map(([actor,f])=>({actor,planetId:f.faith!.sites.find(s=>s.main)!.planetId,day:state.day}));
  for(const [actor,f] of Object.entries(state.factions)){
    f.responsibility=newResponsibility(state.day);
    if(route(state,actor)==='militarist'&&['welfare','utopian'].includes(f.welfare!.choice))throw Error('旧军国高福利与5.2不兼容，请先在旧规则明确调整至第三至第五档再创建分支');
    for(const system of state.systems.filter(s=>f.surveyed.includes(s.id)&&s.planets.some(p=>p.holyCandidate)))discoverHoly(state,actor,system,true);
  }
  v4Event(state,'beacon','显式迁移5.2：保留资产与制度，给予完整责任整备期，不追补历史责任',Object.keys(state.factions),{from:original.rulesRevision,revision:'5.2',founders:state.social!.founders});refreshIntel(state);return state;
}

export function migrateDecisionBalance(original: GameState): GameState {
  if (original.result) throw new Error('已结束比赛不能迁移继续运行');
  if (original.rulesRevision === '5.1') return structuredClone(original);
  const state = migrateCivilization(original);
  const prior = new Set(state.systems.filter(s=>s.planets.some(p=>p.holyCandidate)).map(s=>s.id));
  const added = assignEarlyHolyCandidates(state.systems,Object.values(state.factions).map(f=>f.homeSystemId),state.config.seed);
  state.rulesRevision = '5.1';
  for (const [actor,f] of Object.entries(state.factions)) {
    f.welfare!.history=[];
    f.welfare!.highestSince=f.welfare!.choice==='utopian'?state.day:null;
    delete f.welfare!.last;
    if(f.beacon) { f.beacon.streak=0; f.beacon.totalDays=0; f.beacon.suppliedDays=0; f.beacon.disqualified=true; }
    for(const system of state.systems.filter(s=>!prior.has(s.id)&&f.surveyed.includes(s.id))) discoverHoly(state,actor,system,true);
  }
  v4Event(state,'beacon','显式迁移5.1：最高福利新账单从现在生效，考核重新累计；保留永久制度、既得成果和原地图',Object.keys(state.factions),{from:original.rulesRevision,revision:'5.1',addedCandidates:added,earlyCandidateUnavailable:added===0,day:state.day});
  refreshIntel(state);
  return state;
}
