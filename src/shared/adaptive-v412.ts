import { ADAPTIVE_V41, type CampaignV41, type CertificateV41, type ReportV41, type RiskWindowV41 } from './adaptive-v41.js';
import type { MilitaryOptionV4 } from './adaptive-v4.js';

export const ADAPTIVE_V412 = {
  ...ADAPTIVE_V41, version:'adaptive-v4.12' as const, revision:'national-capacity-6',
  residualForecastShare:.25, minimumGain:.01, supportWindow:300,
  normalWorstWeight:.5, contestWorstWeight:.25,
  developmentOptionWeight:.65,
} as const;
export interface CausesV412 {
  fundingDays:number; fundingSeverity:number; blockedDays:number; blockedSeverity:number;
  supplyRecoveryDay:number|null; fundingRecoveryDay:number|null;
  dissatisfaction:number; overdueDays:number; faithCrisis:number; quality:number;
  resources:Record<string,number>;
}
export interface RiskWindowV412 extends RiskWindowV41 { causes?:CausesV412 }
export interface CertificateV412 extends Omit<CertificateV41,'windows'|'evidence'> {
  windows:RiskWindowV412[]; evidence:CertificateV41['evidence']|'static-bound';
}
export type ValueV412=import('./adaptive-v41.js').ValueV41;
export interface WaveV412 {
  role:'assault'|'garrison'|'support'|'home'; fleetIds:string[]; shipIds:string[];
  target:string; staging:string; departureDay:number; arrivalDay:number;
  projects:{id:string;systemId:string;shipType:import('./rules.js').ShipType;completeDay:number;arrivalDay:number}[];
}
export interface CampaignV412 extends CampaignV41 {
  waves?:WaveV412[]; reassess?:boolean; assessment?:'continue'|'reinforce'|'adjust'|'exit';
  allocationDay?:number; firstContactDay?:number;
}
export interface MilitaryOptionV412 extends MilitaryOptionV4 {
  response?:'orders'|'wait'; dependencyKey?:string; baselineValue?:number;
  avoidedLoss?:number; evaluated?:boolean; baselineScenarios?:MilitaryOptionV4['scenarios'];
  threatFleetIds?:string[];
  variant?:'limited'|'concentrated'|'supported'|'hold'|'continue'; waves?:WaveV412[];
  holding?:boolean; heldDays?:number; requiredPower?:number; paidPower?:number; shortPower?:number;
  scenarioEvidence?:{kind:string;day:number;source:string;assumption:string}[];
  distinctScenarios?:number; eliminated?:boolean; planKey?:string;
}
export interface NationalPlanV412 {
  id:string; kind:'continue'|'recover'|'develop'|'defend'|'campaign'; target:string;
  reason:string; nextStep:string; completion:string; deadline:number; lastProgressRound:number;
  reserve:Record<string,number>; projects:string[]; ships:string[]; dependencies:string[];
  value:number; alternatives:{kind:string;value:number;reason:string}[];
}
export interface MemoryV412 {
  capacity?:CapacityV412;
  national?:NationalPlanV412;
  development?:DevelopmentV412;
  feedback:{round:number;kind:string;expected:number;actual:number;reason:string}[];
  expected?:{round:number;unity:number;quality:number;resources:Record<string,number>;ships:string[];target?:string;heldDays:number};
  reactions:{opponent:string;systemId:string;day:number;power:number;source:string}[];
}
export interface ReportV412 extends Omit<ReportV41,'certificates'|'windows'> {
  capacity?:CapacityV412;
  branchMilitary?:{prefix:string;dependencyKey:string;evaluated:string[];deferred:string[]}[];
  certificates:CertificateV412[]; windows:RiskWindowV412[];
  candidates:{id:string;prefix:string;state:'illegal'|'blocked'|'inferior'|'deferred'|'selected';reason:string;phase:string}[];
  national?:NationalPlanV412; feedback:MemoryV412['feedback'];
  staticAccepted:number; military?:MilitaryOptionV412[];
  development?:{selected?:DevelopmentV412;alternatives:DevelopmentV412[];optionValue:number};
}

export interface CapacityV412 {
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
export interface DevelopmentV412 {
  id:string; systemId:string; planetId:string;
  next:'base'|'colonize'|'production'; action:import('./types.js').Action;
  readyDay:number; colonyDay:number; productiveDay:number;
  reserve:Record<string,number>; cost:Record<string,number>; projects:string[];
  value:number; optionValue:number; reason:string;
}
