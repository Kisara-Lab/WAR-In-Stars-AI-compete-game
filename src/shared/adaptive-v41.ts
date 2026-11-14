import { ADAPTIVE_V4, type CampaignV4, type RiskV4 } from './adaptive-v4.js';
import type { Action } from './types.js';

export const ADAPTIVE_V41 = {
  ...ADAPTIVE_V4, version: 'adaptive-v4.1' as const, revision: 'certified-campaign-2',
  residualShare: .25, repairForecasts: 4, residualForecastShare: .25,
  softWeights: [1, .75, .35, .15], valueWeights: [.1, .2, .3, .4],
  minimumGain: .001, repairBatch: 4,
} as const;

export interface ValueV41 { score:number; economy:number; functional:number; conditional:number; softCost:number; total:number }
export interface RiskWindowV41 extends RiskV4 { days:number; unity:number; quality:number }
export interface CertificateV41 {
  id:string; boundaryHash:string; prefixHash:string; draftHash:string; forecastHash:string;
  groups:string[]; dependencies:Record<string,string[]>; exclusive:string[];
  windows:RiskWindowV41[]; value:ValueV41; evidence:'forecast'|'unchanged-economy';
  status:'compared'|'accepted'|'rejected'|'final'; reason?:string;
}
export interface CampaignV41 extends CampaignV4 {
  warId?:string; milestones?:{reconDay:number;prepared:boolean;arrived:string[];distance:number;held:number;launched:boolean;destination?:string};
  lastAssessmentRound?:number; launchBy?:number; shipIds?:string[];
}
export interface ReportV41 {
  certificates:CertificateV41[]; finalCertificate:string;
  removed:{id:string;actions:Action[];reason:string;dependents:string[]}[];
  selectedGroups:{id:string;phase:string;actions:number}[];
  submittedGroups:string[]; stopReasons:string[];
  repairs:number; rollbacks:number; forecastCacheHits:number;
  windows:RiskWindowV41[]; militaryPlanRefreshes:number;
}
