import type { Action } from '../shared/types.js';
import type { ScriptMemory, ScriptReport } from '../shared/adaptive.js';
import type { economicForecast } from './forecast.js';

export type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;
export interface ScriptCandidate {
  id: string; label: string; kind: string; target: string; actions: Action[];
  priority: number; value: number; risk: number; reason: string;
  evidenceDays: number[]; progress: string; deadline: number;
  economic: boolean; exclusive: string[]; fingerprint: string;
  tasks: ScriptMemory['tasks'];
}
export interface ScriptObservation {
  actor: string; round: number; day: number; remainingDays: number; actionLimit: number;
  facts: unknown; candidates: ScriptCandidate[]; generated: number; truncated: boolean;
  goalStatus?: {valid:boolean;completed:boolean;progress:string;reason:string};
}
export interface ScriptPreview {
  ok: boolean; reason: string; actionCount: number; risk: number; value: number;
  projection?: ReturnType<typeof economicForecast>;
}
export interface ScriptPlanning {
  preview(actions: Immutable<Action[]>, candidate: Immutable<ScriptCandidate> | null, forecast: boolean): ScriptPreview;
  yield(): Promise<void>;
}
export interface ScriptPlan { actions: Action[]; memory: ScriptMemory; report: ScriptReport; summary: string }
