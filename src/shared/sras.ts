import type { Action } from './types.js';

export const SRAS = {
  version: 'sras-v1', revision: 'rules-5', previews: 128, actions: 48, validations: 3,
  budgets: { emergency:32, economy:48, campaign:24, fallback:24 },
  switchCooldownRounds:3,
  reserveDays: 300, intelDays: 200, attackRatio: 1.5, stalledRounds: 2,
  stageEnds: [20, 40, 80, 105, 120], settlementDays: 200,
  investmentDays: 400, minimumFleetPower: 120, shipQueue: 2,
  development: {
    mineralsPerColony: 30, minimumMineralNet: 80,
    energyPerColony: 8, foodPerColony: 5,
    startupPopulation: 2, savingRounds: 6,
    maxUnservicedColonies: 1,
    coloniesPerShipyard: 4,
  },
  phaseExperts: {
    exploration: ['exploration','economy','campaign','opportunity'],
    industry: ['economy','exploration','campaign','opportunity'],
    competition: ['campaign','economy','opportunity','exploration'],
    realization: ['campaign','endgame','economy','opportunity','exploration'],
    endgame: ['endgame','campaign','economy','opportunity','exploration'],
  },
} as const;
export const SRAS_STAGES = ['exploration', 'industry', 'competition', 'realization', 'endgame'] as const;
export function srasStage(round: number, maxRounds: number) {
  return SRAS_STAGES[SRAS.stageEnds.findIndex(end => Math.max(1, round) * 120 <= end * Math.max(1, maxRounds))] ?? 'endgame';
}
export type Expert = 'crisis' | 'defense' | 'diplomacy' | 'campaign' | 'economy' | 'exploration' | 'opportunity' | 'endgame';
export interface SrasTask {
  id: string; expert: Expert; target: string; assets: string[]; reserve: Record<string, number>;
  stage: 'investigate' | 'recon' | 'prepare' | 'assemble' | 'launch' | 'control' | 'settle' | 'exit';
  opponent?: string; warId?: string; warType?: string; deadline: number;
  evidence: string; lastProgressRound: number; diagnosedRound?: number;
  next: string; blockers: string[]; exit: string;
  progress?: { objective: string; distance: Record<string, number> };
  rally?: string;
  requiredPower?: number;
  condition?: string;
  plannedGroup?: string;
  status?: "planned" | "accepted" | "executed" | "completed";
}
export interface SrasMemory {
  revision: string; stage: string; tasks: SrasTask[];
  failures: { id: string; dependency: string; actions: Action[]; reason: string; category: string }[];
  cooldowns?: Record<string,string>;
  switches?: Record<string,{round:number;value:string}>;
  lastActivityRound?: number;
  situation?: string[];
  waiting?: {id:string;reason:string;earliestDay:number|null}[];
}
export interface SrasReport {
  revision: string; stage: string; triggers: string[]; tasks: SrasTask[];
  previews: number; actions: number; stop: string; normalNet: Record<string, number>;
  reserves: Record<string, number>; deficits: Record<string, number>;
  groups: { id: string; expert: Expert; actions: Action[]; dependencies: string[]; status: 'accepted' | 'removed'; reason: string }[];
  blocked: { id: string; expert: Expert; reason: string }[];
  situation?: string[];
  budget?: Record<string,number>;
  counters?: {unique:number;duplicates:number;conflicts:number;accepted:number;rejected:number};
  fallback?: {check:string;status:string;reason:string}[];
  threats?: {system:string;power:number;arrival:number;fleets:string[]}[];
  netChanges?: number;
  coverage?: Record<string,{generated:number;accepted:number}>;
  funding?: {id:string;resource:string;gap:number;normalNet:number;earliestDay:number|null}[];
  removed?: {id:string;reason:string}[];
  exposure?: {fleet:string;alternatives:{system:string;arrival:number}[]}[];
  execution?: {accepted:number;failed:number;completedTasks:string[]};
}
