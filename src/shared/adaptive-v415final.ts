import { ADAPTIVE_V41, type CampaignV41, type CertificateV41, type ReportV41, type RiskWindowV41 } from './adaptive-v41.js';
import type { MilitaryOptionV4 } from './adaptive-v4.js';

export const ADAPTIVE_V415Final = {
  ...ADAPTIVE_V41, version:'adaptive-v4.15-final' as const, revision:'realization-3',
  residualForecastShare:.25, minimumGain:.01, supportWindow:300,
  normalWorstWeight:.5, contestWorstWeight:.25,
  developmentOptionWeight:.65,
} as const;
export interface CausesV415Final {
  fundingDays:number; fundingSeverity:number; blockedDays:number; blockedSeverity:number;
  supplyRecoveryDay:number|null; fundingRecoveryDay:number|null;
  dissatisfaction:number; overdueDays:number; faithCrisis:number; quality:number;
  resources:Record<string,number>;
}
export interface RiskWindowV415Final extends RiskWindowV41 { causes?:CausesV415Final }
export interface CertificateV415Final extends Omit<CertificateV41,'windows'|'evidence'> {
  windows:RiskWindowV415Final[]; evidence:CertificateV41['evidence']|'static-bound';
}
export type ValueV415Final=import('./adaptive-v41.js').ValueV41;
export interface WaveV415Final {
  role:'assault'|'garrison'|'support'|'home'; fleetIds:string[]; shipIds:string[];
  target:string; staging:string; departureDay:number; arrivalDay:number;
  projects:{id:string;systemId:string;shipType:import('./rules.js').ShipType;completeDay:number;arrivalDay:number}[];
}
export interface CampaignV415Final extends CampaignV41 {
  waves?:WaveV415Final[]; reassess?:boolean; assessment?:'continue'|'reinforce'|'adjust'|'exit';
  allocationDay?:number; firstContactDay?:number;
}
export interface MilitaryOptionV415Final extends MilitaryOptionV4 {
  response?:'orders'|'wait'; dependencyKey?:string; baselineValue?:number;
  avoidedLoss?:number; evaluated?:boolean; baselineScenarios?:MilitaryOptionV4['scenarios'];
  threatFleetIds?:string[];
  variant?:'limited'|'concentrated'|'supported'|'hold'|'continue'; waves?:WaveV415Final[];
  holding?:boolean; heldDays?:number; requiredPower?:number; paidPower?:number; shortPower?:number;
  scenarioEvidence?:{kind:string;day:number;source:string;assumption:string}[];
  distinctScenarios?:number; eliminated?:boolean; planKey?:string;
}
export interface NationalPlanV415Final {
  id:string; kind:'continue'|'recover'|'develop'|'defend'|'campaign'; target:string;
  reason:string; nextStep:string; completion:string; deadline:number; lastProgressRound:number;
  reserve:Record<string,number>; projects:string[]; ships:string[]; dependencies:string[];
  value:number; alternatives:{kind:string;value:number;reason:string}[];
}
export interface MemoryV415Final {
  portfolio?: PortfolioV415Final;
  tasks?: ContinuityTaskV415Final[];
  capacity?:CapacityV415Final;
  national?:NationalPlanV415Final;
  development?:DevelopmentV415Final;
  feedback:{round:number;kind:string;expected:number;actual:number;reason:string}[];
  expected?:{round:number;unity:number;quality:number;resources:Record<string,number>;ships:string[];target?:string;heldDays:number};
  reactions:{opponent:string;systemId:string;day:number;power:number;source:string}[];
}
export interface ReportV415Final extends Omit<ReportV41,'certificates'|'windows'> {
  portfolio?: PortfolioV415Final;
  tasks?: ContinuityTaskV415Final[];
  capacity?:CapacityV415Final;
  branchMilitary?:{prefix:string;dependencyKey:string;evaluated:string[];deferred:string[]}[];
  certificates:CertificateV415Final[]; windows:RiskWindowV415Final[];
  candidates:{id:string;prefix:string;state:'illegal'|'blocked'|'inferior'|'deferred'|'selected';reason:string;phase:string}[];
  national?:NationalPlanV415Final; feedback:MemoryV415Final['feedback'];
  staticAccepted:number; military?:MilitaryOptionV415Final[];
  development?:{selected?:DevelopmentV415Final;alternatives:DevelopmentV415Final[];optionValue:number};
}

export interface ContinuityTaskV415Final {
  id:string; target:string; kind:'development'|'campaign'|'responsibility';
  createdRound:number; lastProgressRound:number; expectedDay:number;
  status:'active'|'blocked'|'reassess'|'complete'|'exit';
  evidence:string; next:string; dependencies:string[];
  blockers?:string[]; funding?:Record<string,number>; outcome?:string;
}
export interface PortfolioV415Final {
  day:number;
  allocations:{id:string;target:string;startDay:number;completeDay:number;cost:Record<string,number>;projects:string[]}[];
  deferred:{id:string;reason:string}[];
  reserved:Record<string,number>;
  conditionalValue:number;
}

export interface CapacityV415Final {
  day:number; dependencyKey:string;
  resources:Record<string,{stock:number;netPer100:number;maintenance:number;reserved:number}>;
  needs:{id:string;target:string;opponent:string;kind:'defend'|'campaign'|'pressure';
    deadline:number;power:number;present:number;paid:number;missing:number;
    fleetIds:string[];projectIds:string[];evidenceDays:number[];conditional:boolean}[];
  projects:{id:string;systemId:string;shipType:string;completeDay:number;taskId?:string;arrivalDay?:number}[];
  allocations:{fleetId:string;shipIds:string[];taskId:string;arrivalDay:number}[];
  development:{id:string;target:string;next:string;readyDay:number;completeDay:number;cost:Record<string,number>}[];
}

/** All amounts are display resources. Unpaid steps are conditional, never assets. */
export interface DevelopmentV415Final {
  id:string; systemId:string; planetId:string;
  next:'base'|'colonize'|'production'; action:import('./types.js').Action;
  readyDay:number; colonyDay:number; productiveDay:number;
  reserve:Record<string,number>; cost:Record<string,number>; projects:string[];
  value:number; optionValue:number; reason:string;
}


