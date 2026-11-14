import { ADAPTIVE_V3 } from './adaptive.js';

export const ADAPTIVE_V4 = {
  version: 'adaptive-v4' as const, revision: 'crisis-campaign-opening-2',
  profiles: ADAPTIVE_V3.profiles,
  horizons: [100, 300, 720, 1440],
  shares: { crisis: .25, military: .25, economy: .5 },
  tacticalPlans: { standard: 12, deep: 32 }, tacticalDays: 600,
  intelDays: 200, stalledRounds: 2, switchRatio: 1.2,
  shortageDayValue: 20, shortageSeverityValue: 30, unpaidValue: 20,
  lowUnityDayValue: .1, recoveryValue: 2, riskTolerance: .01,
  oppositionWeight: 1, uncertainOppositionWeight: .5, preparationDiscount: .6,
  assaultSpreadDays: 20, investmentValue: .12, surplusValue: .003,
  crisisDays: 300,
  discoveryOptionWeight: .6, scoutingValue: 20,
  sensorUnknownValue: 2, sensorForeignValue: 16, sensorStaleValue: 10, sensorTaskValue: 12,
} as const;

export interface RiskV4 {
  shortageDays:number; shortageSeverity:number; unpaidDays:number; unpaidSeverity:number;
  lowUnityDays:number; recoveryDay:number|null; shortfall:Record<string,number>; value:number;
}
export interface CampaignV4 {
  id:string; opponent:string; targets:string[]; warType:string;
  stage:'investigate'|'recon'|'prepare'|'assemble'|'attack'|'control'|'settle'|'exit';
  fleetIds:string[]; staging:string|null; createdDay:number; deadline:number;
  progress:string; lastProgressRound:number; value:number; reserve:Record<string,number>;
  blockers:string[]; nextStep:string; launchDay:number|null; ready:boolean;
  completed?:boolean; exitReason?:string;
}
export interface TacticalScenarioV4 {
  kind:'hold'|'reinforce'|'counterattack'; won:boolean; ownLoss:number; enemyLoss:number;
  capturedDay:number|null; heldDays:number; exposedLoss:number; value:number;
}
export interface MilitaryOptionV4 {
  id:string; opponent:string; target:string; warType:string; mode:'defend'|'limited'|'concentrated';
  fleetIds:string[]; staging:string|null; arrival:number; expectedDay:number;
  knownPower:number; availablePower:number; unknown:boolean; intelDays:number[];
  scenarios:TacticalScenarioV4[]; territory:number; duty:number; maintenance:number;
  value:number; blockers:string[]; ready:boolean; preparation:boolean;
  claim?:boolean; availableDay?:number;
}
export interface ReportV4 {
  risk:RiskV4; finalRisk:RiskV4; posture:'protect'|'balanced'|'contest';
  military:MilitaryOptionV4[]; tacticalEvaluations:number;
  crisisChecked:boolean; pending:{id:string;reason:string;dependency:string}[];
  stageBudgets:Record<string,{evaluations:number;forecasts:number;limit:number;forecastLimit:number}>;
  scoreIntervals:Record<string,{low:number;high:number|null}>;
}
