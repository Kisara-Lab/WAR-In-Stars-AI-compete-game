import type { GameState, Resources } from './types.js';
import { controller } from './v4.js';
import { modernRules, decisionBalanced, responsible, responsibilityView, WELFARE_52 } from './responsibility.js';

export const CIVILIZATION = {
  revision: '5.0', welfareCooldown: 360, qualificationDays: 720, qualificationFraction: .9, qualificationUnity: 80,
  brokenPromise: 6, religiousBrokenPromise: 2, utopiaGrowth: 1.15, utopiaUnity: 2,
  militaryCombat: 1.10, militaryShipSpeed: 1.15, militaryMaintenance: 1.10, militaryIndustryPenalty: 1.25,
  preparationDays: 180, preparationMinerals: 150, preparationFood: 50, preparationUnity: 5,
  holyProduction: 1.10, exerciseCombat: 1.03, exerciseMaintenance: 1.05, exchangeUnity: .5, exchangeGrowth: 1.05, listeningMaintenance: .85,
} as const;
export const WELFARE = {
  survival: { name: '维持生存', energy: .25, minerals: .10, food: .25, unity: -3 },
  basic: { name: '基础保障', energy: .50, minerals: .25, food: .50, unity: -1 },
  comfortable: { name: '均衡小康', energy: 1, minerals: .50, food: 1, unity: 0 },
  welfare: { name: '福利国家', energy: 2, minerals: 1, food: 1.5, unity: 2 },
  utopian: { name: '乌托邦社会', energy: 3, minerals: 2, food: 2, unity: 4 },
  church: { name: '教廷保障', energy: 1.5, minerals: .75, food: 1.25, unity: 1 },
} as const;
export const DECISION_BALANCE = { revision: '5.1', highestWelfare: { energy: 5, minerals: 3, food: 5 }, earlyHoly: { nearest: 1, second: 4, difference: 2 } } as const;
export const welfareRules = (state: {rulesRevision?: string}): typeof WELFARE extends infer T ? { [K in keyof T]: { name: string; energy: number; minerals: number; food: number; unity: number } } : never => responsible(state)
  ? Object.fromEntries(Object.entries(WELFARE).map(([id,rule])=>[id,{...rule,...WELFARE_52[id as keyof typeof WELFARE_52]}])) as ReturnType<typeof welfareRules>
  : decisionBalanced(state) ? {...WELFARE, utopian: {...WELFARE.utopian, ...DECISION_BALANCE.highestWelfare}} : WELFARE;
export const CIVILIZATION_NAMES = { secular: '普通世俗', utopia: '乌托邦共同体', militarist: '永久军国主义', theocracy: '永久国教' };
export const V5_POLICIES = {
  none: { name: '不采用政策', energy: 1, minerals: 1, food: 1, unity: 0, combat: 1, penalty: 1 },
  exercises: { name: '加强演习', energy: 1, minerals: 1, food: 1, unity: 0, combat: 1, penalty: 1 },
  exchange: { name: '对外交流', energy: 1, minerals: 1, food: 1, unity: .5, combat: 1, penalty: 1 },
  listening: { name: '子空间监听', energy: 1, minerals: 1, food: 1, unity: 0, combat: 1, penalty: 1 },
} as const;
export type WelfareId = keyof typeof WELFARE;
export type CivilizationId = keyof typeof CIVILIZATION_NAMES;
export interface WelfarePayment { day: number; population: number; reachablePopulation: number; due: Resources; deliverable: Resources; paid: Resources; fraction: number; reasons: string[]; aid?: Resources; selfPaid?: Resources }
export interface WelfareState { choice: WelfareId; selectedDay: number; firstChoice: boolean; highestSince: number | null; history: { day: number; qualified: boolean }[]; last?: WelfarePayment; rounding?: { due: Resources; deliverable: Resources } }
export interface CivilizationState { choice: CivilizationId; establishedDay: number; historyBeacon?: unknown }
export const modern = modernRules;
export const route = (state: GameState, actor: string): CivilizationId => modern(state) ? state.factions[actor].civilization?.choice ?? 'secular' : state.factions[actor].faith ? 'theocracy' : 'secular';
export function initializeCivilization(state: GameState, actor: string, migration = false) {
  const f = state.factions[actor];
  f.civilization = { choice: f.faith ? 'theocracy' : 'secular', establishedDay: state.day, ...(migration && f.beacon ? { historyBeacon: structuredClone(f.beacon) } : {}) };
  f.welfare = { choice: f.faith ? 'church' : 'comfortable', selectedDay: state.day, firstChoice: !f.faith, highestSince: null, history: [] };
}
export function welfarePopulations(state: GameState, actor: string) {
  let population = 0, reachablePopulation = 0;
  for (const s of state.systems) for (const p of s.planets) if (p.ownerId === actor) { population += p.population; if (s.ownerId === actor && controller(s) === actor) reachablePopulation += p.population; }
  return { population, reachablePopulation };
}
export function welfareQuote(state: GameState, actor: string, days = 100): {population:number;reachablePopulation:number;due:Resources;deliverable:Resources;rounding?:{due:Resources;deliverable:Resources}} {
  const f = state.factions[actor], rule = welfareRules(state)[f.welfare?.choice ?? 'comfortable'];
  const populations = welfarePopulations(state, actor);
  if(responsible(state)){
    const charge=(population:number,carry:Resources|undefined)=>{
      const amount:Resources={energy:0,minerals:0,food:0},remainder:Resources={energy:0,minerals:0,food:0};
      for(const k of ['energy','minerals','food'] as const){const numerator=Math.round(rule[k]*10000)*population*days+(carry?.[k]??0);amount[k]=Math.floor(numerator/1000);remainder[k]=numerator%1000;}
      return {amount,remainder};
    };
    const due=charge(populations.population,f.welfare?.rounding?.due),deliverable=populations.population===populations.reachablePopulation?due:charge(populations.reachablePopulation,f.welfare?.rounding?.deliverable);
    return {...populations,due:due.amount,deliverable:deliverable.amount,rounding:{due:due.remainder,deliverable:deliverable.remainder}};
  }
  const bill = (population: number): Resources => ({ energy: Math.round(rule.energy * population * days * 10), minerals: Math.round(rule.minerals * population * days * 10), food: Math.round(rule.food * population * days * 10) });
  return { ...populations, due: bill(populations.population), deliverable: bill(populations.reachablePopulation) };
}
export function utopiaOperating(state: GameState, actor: string) {
  const f = state.factions[actor];
  return route(state, actor) === 'utopia' && f.welfare?.last?.fraction === 1 && !Object.values(f.shortages).some(Boolean);
}
export function civilizationEligibility(state: GameState, actor: string, choice: 'utopia' | 'militarist') {
  const f = state.factions[actor], w = f.welfare;
  const blockers: string[] = [];
  if (!modern(state)) blockers.push('此命令需要V5规则');
  if (route(state, actor) !== 'secular') blockers.push('永久文明路线不可撤销或转换');
  if (choice === 'utopia') {
    if (!w || w.choice !== 'utopian' || w.highestSince === null || state.day - w.highestSince < CIVILIZATION.qualificationDays) blockers.push('须连续最高待遇满720日');
    const intervals = w?.history.filter(h => h.day > state.day - CIVILIZATION.qualificationDays) ?? [];
    if (intervals.length < 72 || intervals.filter(h => h.qualified).length / 72 < CIVILIZATION.qualificationFraction) blockers.push('最近720日至少90%区间须足额福利、正常供应、凝聚力≥80');
    if (w?.last?.fraction !== 1 || Object.values(f.shortages).some(Boolean)) blockers.push('当前福利和基础供应须正常');
    if ((state.conquests ?? []).some(c => c.actor === actor && c.endedDay === undefined)) blockers.push('须先明确撤回活动征服准备');
  }
  return { allowed: blockers.length === 0, blockers };
}
export function civilizationView(state: GameState, actor: string) {
  const f = state.factions[actor], w = f.welfare;
  const shown = (resources: Resources) => Object.fromEntries(Object.entries(resources).map(([k,v])=>[k,v/1000]));
  const quote = welfareQuote(state,actor);
  return { ...(responsible(state)?{responsibilities:responsibilityView(state,actor)}:{}), route: f.civilization, welfare: w ? { ...w, history: undefined, last: w.last ? {...w.last, due: shown(w.last.due), deliverable: shown(w.last.deliverable), paid: shown(w.last.paid)} : undefined } : null, billPer100: {...quote, due: shown(quote.due), deliverable: shown(quote.deliverable)}, choices: welfareRules(state), rules: {...CIVILIZATION, revision:state.rulesRevision}, eligibility: { utopia: civilizationEligibility(state, actor, 'utopia'), militarist: civilizationEligibility(state, actor, 'militarist') }, nextWelfareDay: w?.firstChoice ? state.day : (w?.selectedDay ?? state.day) + CIVILIZATION.welfareCooldown, operating: utopiaOperating(state, actor), qualifiedIntervals: w?.history.filter(h => h.qualified).length ?? 0, qualificationIntervals: 72, permanent: responsible(state)?'三条文明路线互斥且永久；最高待遇不等于乌托邦制度；军国仅可选小康、基础、生存三档待遇': '乌托邦、军国主义、国教互斥且永久；最高待遇不是乌托邦制度；军国可付最高福利但不能获得乌托邦成果', warfare: route(state, actor) === 'utopia' ? '禁止prepare_conquest；允许宣称割地、有限军事、保卫及持合法重大理由的总体战。参战不使灯塔失格。' : '战争仍须满足理由、目标和条约；没有理由时可评估征服准备' };
}
