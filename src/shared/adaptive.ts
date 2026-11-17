import type { Action } from './types.js';

export const ADAPTIVE = {
  version: 'adaptive-v1' as const, revision: '5.4', candidates: 256, forecasts: 24,
  attempts: 3, safetyDays: 300, horizons: [720, 1440], intelDays: 200,
  attackRatio: 1.3, switchRatio: 1.2, stalledRounds: 2, reserveDays: 100,
  horizonDiscount: .5, materialValue: .025, economicValue: .12,
  shortagePenalty: 20, unpaidPenalty: 10, unityValue: 3, colonyValue: 250,
  missionValue: 100, dutyValue: 150, explorationValue: 35, baseValue: 100,
  defenseValue: 300, capacityValue: 40, progressQuantum: 10,
  militaryUncertainty: 1.25, peaceLossWeight: 2,
  supplyWeight: 4, rawMaterialWeight: 1, alloyWeight: 4, surplusWeight: .03,
  fleetScoreWeight: 1, futureFleetWeight: .35, routeCost: .1,
  healthUnity: 60, growthValue: 20, minInvestmentDays: 300,
} as const;

export interface ScriptGoal {
  id: string; kind: string; target: string; stage: string; value: number;
  prerequisites: string[]; deadline: number; progress: string; lastProgressRound: number;
}
export interface ScriptMemory {
  sras?: import('./sras11.js').SrasMemory;
  cerberus?: import('./sras13.js').CerberusMemory;
  v412?: import('./adaptive-v412.js').MemoryV412;
  v415?: import('./adaptive-v415.js').MemoryV415;
  v415final?: import('./adaptive-v415final.js').MemoryV415Final;
  version: 'adaptive-v1' | 'adaptive-v2' | 'adaptive-v3' | 'adaptive-v4' | 'adaptive-v4.1' | 'adaptive-v4.12' | 'adaptive-v4.15' | 'adaptive-v4.15-final' | 'sras-v1' | 'sras-v1.1' | 'sras-v1.3cerberus'; goal: ScriptGoal | null;
  tasks: { fleetId: string; role: 'defend' | 'assemble' | 'attack' | 'hold' | 'withdraw'; target: string; warId?:string; expiresDay?:number; campaignId?:string }[];
  failures: { key: string; fingerprint: string; round: number; reason: string }[];
  campaign?: { opponent:string; target:string; stage:string; reserve:Record<string,number>; progress:string; lastProgressRound:number; blockers:string[]; nextStep?:string; expectedDay?:number; completion?:string; value?:number; committed?:boolean; paidPower?:number };
  recovery?: {deadline:number;lastCheckedDay:number;shortages:Record<string,boolean>;welfareFraction:number;normalNet:Record<string,number>};
  operation?: import('./adaptive-v4.js').CampaignV4;
}
export interface ScriptAlternative {
  id: string; label: string; priority: number; value: number; risk: number;
  reason: string; evidenceDays: number[]; selected: boolean;
}
export interface ScriptReport {
  sras?: import('./sras11.js').SrasReport;
  cerberus?: import('./sras13.js').CerberusReport;
  v412?: import('./adaptive-v412.js').ReportV412;
  v415?: import('./adaptive-v415.js').ReportV415;
  v415final?: import('./adaptive-v415final.js').ReportV415Final;
  version: 'adaptive-v1' | 'adaptive-v2' | 'adaptive-v3' | 'adaptive-v4' | 'adaptive-v4.1' | 'adaptive-v4.12' | 'adaptive-v4.15' | 'adaptive-v4.15-final' | 'sras-v1' | 'sras-v1.1' | 'sras-v1.3cerberus'; candidates: number; forecasts: number; validations: number;
  v4?: import('./adaptive-v4.js').ReportV4;
  v41?: import('./adaptive-v41.js').ReportV41;
  performance?: Record<string, number>;
  selectedProjection?:string;
  search?: { profile:'standard'|'deep'; evaluations:number; depth:number; combinations:{ids:string[];risk:number;criticalThreats?:number;economic:number;functional:number;conditional:number}[] };
  comparisons?: {routes: unknown; sensors: unknown; wars: unknown};
  exhausted: boolean; alternatives: ScriptAlternative[];
  turn?: { revision:string; actions:number; planets:number; stop:string; stages:Record<string,{evaluations:number;forecasts:number;actions:number}>; opportunities:{id:string;label:string;reason:string;value:number}[]; value:{score:number;economy:number;functional:number;conditional:number;governanceCost:number}; welfareSafe:boolean; threats:unknown[] };
  selected: { id: string; label: string; actions: Action[]; fingerprint: string }[];
  rejected: { attempt: number; index: number; reason: string }[];
  assumptions: string;
  projections?: {id:string;horizons:{days:number;resources:Record<string,number>;unity:number;population:number;shortageDays:number;unpaidDays:number}[];trajectory?:{day:number;unity:number;quality:number;welfare:number}[]}[];
}
export const scriptName = (config: {controller: string; scriptStrategy?: string}) => config.controller === 'mixed' ? 'AI VS 智能脚本' : config.controller !== 'scripted'
  ? 'AI 模型对战' : config.scriptStrategy?.startsWith('adaptive-') || config.scriptStrategy?.startsWith('sras-') ? '智能脚本 '+config.scriptStrategy : '旧脚本基线';

export const ADAPTIVE_V2 = {
  ...ADAPTIVE, version: 'adaptive-v2' as const, stageCache: 64, threadBudget: 16,
  sensorSystemValue: 16, sensorStaleValue: 12, sensorThreatValue: 30,
  sensorTaskValue: 24, cancellationLoss: .5, commitmentRisk: .35,
  responsibilityRisk: 90, conquestOptionValue: 100, queueDays: 500,
  forecastBatch: 4, stageDiscount: .6, responsibilityHorizon: 1440,
  housingPersonValue: 5, currentFleetServiceValue: .025,
  commitmentOptionCost: 100, unityRiskPerPoint: 10,
} as const;

export const ADAPTIVE_V3 = {
  version: 'adaptive-v3', repair: 'whole-turn-1', threadBudget: 64, cacheMiB: 8192,
  residualShare: .25, combinationForecastShare: .5, residualBatch: 8,
  operatingHorizon: 720, investmentValue: .12, surplusValue: .003,
  unityDayCost: .05, unityDeclineCost: .5, conditionalWeight: .25,
  profiles: {
    standard: { candidates: 256, width: 4, depth: 3, evaluations: 256, forecasts: 48 },
    deep: { candidates: 512, width: 8, depth: 4, evaluations: 1024, forecasts: 128 },
  },
} as const;
