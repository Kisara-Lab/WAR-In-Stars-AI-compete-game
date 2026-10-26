import { emergencyView } from './emergency.js';
import { governed } from './governance.js';
import type { GameState, Resources } from './types.js';

export const RESPONSIBILITY = {
  revision: '5.2', holyCount: 2, holyNearestMin: 1, holyNearestMax: 2, holySecondMax: 4, holyDistanceGap: 2, holySeparation: 3,
  religiousGrace: 1080, religiousPressure: 6, religiousEscalatedPressure: 10, religiousEscalationDays: 720,
  militaryGrace: 720, militaryPressure: 5, militaryFailure: 20, militaryTiers: [{ minimum: 0, unity: 0 }, { minimum: 20, unity: -1 }, { minimum: 40, unity: -3 }, { minimum: 70, unity: -6 }],
  achievementDays: 1800, battleBuffer: 360, reportDays: 100, concernDays: 300, responseDays: 360,
  rescuePenaltyPer100: 50, rescuePenaltyCap: 300, penaltyRecoveryDays: 300,
  aid: { energy: 300, minerals: 150, food: 300 }, offerDays: 180, aidDays: 360, aidProgressDays: 100,
  reformDays: 1080, reformRecoveryDays: 180, reformWindow: 360, reformFraction: .9, reformSuccessDays: 360,
  reformFailureDays: 100, supervisionBuffer: 720, breachReasonDays: 1080,
} as const;
export const responsible = (state: { rulesRevision?: string }) => ['5.2', '5.3', '5.4'].includes(state.rulesRevision ?? '');
export const decisionBalanced = (state: { rulesRevision?: string }) => ['5.1', '5.2', '5.3', '5.4'].includes(state.rulesRevision ?? '');
export const modernRules = (state: { rulesRevision?: string }) => ['5.0', '5.1', '5.2', '5.3', '5.4'].includes(state.rulesRevision ?? '');
export const WELFARE_52 = {
  survival: { energy: .25, minerals: .10, food: .25 }, basic: { energy: .55, minerals: .275, food: .55 },
  comfortable: { energy: 1.25, minerals: .625, food: 1.25 }, welfare: { energy: 3, minerals: 1.5, food: 2.25 },
  utopian: { energy: 5, minerals: 3, food: 5 }, church: { energy: 1.875, minerals: .9375, food: 1.5625 },
} as const;
export interface ResponsibilityState {
  extractionLast?: { day:number; details:{eventId:string;ignored:boolean;reason:string}[] };
  startedDay: number; overdueDays: number; dissatisfaction: number; satisfiedUntil: number;
  bufferedWars: Record<string, number>; awardedWars: string[]; missionIds: string[];
  last?: { day: number; actionable: boolean; blocked: string[]; buffer: boolean; pressure: number };
  rescuePenalty: number; ignored: boolean; recovery?: { startedDay: number; amount: number };
  responses: Record<string, { knownDay: number; fulfilled?: boolean; bufferedDays: number }>;
}
export interface SocialReport { target: string; day: number; welfare: string; delivery: 'at_least_90' | '50_to_90' | 'below_50'; distressed: boolean }
export interface Concern { id: string; target: string; openedDay: number; closedDay?: number; known: Record<string, number>; clearDays: number }
export interface Aid {
  id: string; actor: string; target: string; concernId: string; createdDay: number; expiresDay: number;
  acceptedDay?: number; endedDay?: number; outcome?: string; remaining: Resources; spent: Resources;
  improvedDays: number; effective?: boolean;
}
export interface Reform {
  extractionId?: string;
  id: string; actor: string; target: string; concernId: string; createdDay: number; offerUntil: number;
  acceptedDay?: number; expiresDay?: number; endedDay?: number; warId?: string; goalId?: string;
  history: { day: number; qualified: boolean }[]; qualifiedDays: number; failedDays: number;
  effective?: boolean; breachedDay?: number; breachExpiresDay?: number;
}
export interface SocialState {
  startedDay: number; founders: { planetId: string; actor: string; day: number }[];
  reports: Record<string, SocialReport>; distress: Record<string, { days: number; lowDays: number; unpaidDays: number; samples: { day: number; fraction: number }[] }>;
  concerns: Concern[]; aid: Aid[]; reforms: Reform[];
}
export const newResponsibility = (day: number): ResponsibilityState => ({ startedDay: day, overdueDays: 0, dissatisfaction: 0, satisfiedUntil: 0, bufferedWars: {}, awardedWars: [], missionIds: [], rescuePenalty: 0, ignored: false, responses: {} });
export const militaryDiscontent = (state: GameState, actor: string) => responsible(state) ? [...RESPONSIBILITY.militaryTiers].reverse().find(t => (state.factions[actor].responsibility?.dissatisfaction ?? 0) >= t.minimum)!.unity : 0;
export const aidView=(aid:Aid)=>({...aid,remaining:Object.fromEntries(Object.entries(aid.remaining).map(([k,v])=>[k,v/1000])),spent:Object.fromEntries(Object.entries(aid.spent).map(([k,v])=>[k,v/1000])),resourceUnits:'实际资源单位'});
export function responsibilityView(state: GameState, actor: string) {
  if (!responsible(state)) return null;
  const related = (target: string) => target === actor || Object.values(state.relations).some(r => r.factions.includes(actor) && r.factions.includes(target) && r.status !== 'unknown' && r.status !== 'contact');
  return { ...(state.rulesRevision==='5.4'?{emergency:emergencyView(state,actor)}:{}), ...(governed(state)?{militaryProgress:state.factions[actor].annexationProgress??null}:{}), rules: RESPONSIBILITY, own: state.factions[actor].responsibility ?? null,
    militaryUnity: militaryDiscontent(state, actor), founders: (state.social?.founders ?? []).filter(f=>related(f.actor)||state.systems.some(s=>state.factions[actor].surveyed.includes(s.id)&&s.planets.some(p=>p.id===f.planetId))),
    reports: Object.values(state.social?.reports ?? {}).filter(r=>related(r.target)),
    concerns: (state.social?.concerns ?? []).filter(c=>c.target===actor||c.known[actor]!==undefined).map(c=>({...c,known:c.known[actor]===undefined?{}:{[actor]:c.known[actor]}})),
    aid: (state.social?.aid ?? []).filter(a=>a.actor===actor||a.target===actor).map(aidView),
    reforms: (state.social?.reforms ?? []).filter(r=>r.actor===actor||r.target===actor),
    semantics: '职责看实际成果；空宣战不算。己方时钟完整，外国仅民生等级与日期，不提供库存/人口/内部危机。国教最多两个永久名额。' };
}
