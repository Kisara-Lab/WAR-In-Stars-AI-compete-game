import { SRAS as SRAS11, type SrasMemory, type SrasReport, type SrasTask } from './sras11.js';
import type { Action } from './types.js';

export interface CerberusReceipt {
  id: string;
  groupId: string;
  action: Action;
  status: 'executed' | 'completed' | 'failed';
  projectIds: string[];
  round: number;
  evidence: string;
}

export const SRAS_CERBERUS = {
  ...SRAS11,
  version: 'sras-v1.3cerberus' as const,
  revision: 'rules-1.3-cerberus-3' as const,
  governanceTrigger: 85,
  governanceEmergency: 70,
  occupationReserveRounds: 3,
  forceConversionRounds: 6,
  qualityBudget: 8,
  governanceHysteresis: 5,
  occupationReservePower: 80,
};

export type CerberusExpert = 'governance-recovery' | 'force-conversion' | 'occupation-garrison' | 'civilization-conversion';
export interface CerberusMemory {
  version: typeof SRAS_CERBERUS.version;
  revision: string;
  tasks: SrasTask[];
  experts: Record<CerberusExpert, { checked: number; actions: number; blockers: string[] }>;
  quality: { planned: number; submitted: number; accepted: number; executed: number; completed: number; stateChanges: number; military: number; governance: number };
  cooldowns: Record<string, string>;
  reserved: { fleets: string[]; resources: Record<string, number> };
  base: SrasMemory;
  baseline?: { population: number; structures: number; ships: number; territories: number };
  realized?: { population: number; structures: number; ships: number; territories: number };
  receipts?: CerberusReceipt[];
}
export interface CerberusReport extends SrasReport {
  revision: typeof SRAS_CERBERUS.revision;
  experts: CerberusMemory['experts'];
  quality: CerberusMemory['quality'] & { acceptedRate: number; executedRate: number; stateChangeRate: number };
  occupation: { target: string; reservePower: number; threatPower: number; retained: boolean; actions: string[]; next: string }[];
  forceConversion: { planetId: string; shipType: string; count: number; reason: string }[];
  realized?: CerberusMemory['realized'];
  receipts?: CerberusReceipt[];
}

export function isCerberusMemory(value: unknown): value is CerberusMemory {
  return !!value && typeof value === 'object' && (value as { version?: string }).version === SRAS_CERBERUS.version;
}
