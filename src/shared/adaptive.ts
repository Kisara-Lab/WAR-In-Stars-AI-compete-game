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
  version: 'adaptive-v1' | 'adaptive-v2' | 'adaptive-v3'; goal: ScriptGoal | null;
  tasks: { fleetId: string; role: 'defend' | 'assemble' | 'attack' | 'hold' | 'withdraw'; target: string }[];
  failures: { key: string; fingerprint: string; round: number; reason: string }[];
  campaign?: { opponent:string; target:string; stage:string; reserve:Record<string,number>; progress:string; lastProgressRound:number; blockers:string[] };
  recovery?: {deadline:number;lastCheckedDay:number;shortages:Record<string,boolean>;welfareFraction:number;normalNet:Record<string,number>};
}
export interface ScriptAlternative {
  id: string; label: string; priority: number; value: number; risk: number;
  reason: string; evidenceDays: number[]; selected: boolean;
}
export interface ScriptReport {
  version: 'adaptive-v1' | 'adaptive-v2' | 'adaptive-v3'; candidates: number; forecasts: number; validations: number;
  performance?: Record<string, number>;
  selectedProjection?:string;
  search?: { profile:'standard'|'deep'; evaluations:number; depth:number; combinations:{ids:string[];risk:number;criticalThreats?:number;economic:number;functional:number;conditional:number}[] };
  comparisons?: {routes: unknown; sensors: unknown; wars: unknown};
  exhausted: boolean; alternatives: ScriptAlternative[];
  selected: { id: string; label: string; actions: Action[]; fingerprint: string }[];
  rejected: { attempt: number; index: number; reason: string }[];
  assumptions: string;
  projections?: {id:string;horizons:{days:number;resources:Record<string,number>;unity:number;population:number;shortageDays:number;unpaidDays:number}[];trajectory?:{day:number;unity:number;quality:number;welfare:number}[]}[];
}
export const scriptName = (config: {controller: string; scriptStrategy?: string}) => config.controller !== 'scripted'
  ? 'AI 模型对战' : config.scriptStrategy?.startsWith('adaptive-') ? '智能脚本 '+config.scriptStrategy : '旧脚本基线';

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
  version: 'adaptive-v3', threadBudget: 64, cacheMiB: 8192,
  profiles: {
    standard: { candidates: 256, width: 4, depth: 3, evaluations: 256, forecasts: 48 },
    deep: { candidates: 512, width: 8, depth: 4, evaluations: 1024, forecasts: 128 },
  },
} as const;
