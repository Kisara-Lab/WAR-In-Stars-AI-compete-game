import type { GameState, Resources } from './types.js';

export const V54 = {
  revision: '5.4', duration: 1800, reserveFraction: .10, governanceCap: .50,
  crisisTarget: 19, unityTarget: 6000, requestDays: 180, ultimatumDays: 180,
  excludedRecoveryStructures: ['shipyard', 'drydock', 'maintenance', 'lrs'],
} as const;
export const emergencyRules = (state?: { rulesRevision?: string }) => state?.rulesRevision === V54.revision;
export interface Extraction {
  id: string; startedDay: number; expiresDay: number; stoppedDay?: number; endedDay?: number;
  initialCrisis: number; initialUnity: number;
  ships: Record<string, { energy: number; minerals: number }>;
  known: Record<string, number>;
  demands: { id: string; actor: string; day: number; deadline: number; rejectedDay?: number; acceptedDay?: number }[];
  reformId?: string; qualifiedDays: number; fulfilledDay?: number; lastProgressDay?: number;
  responses: Record<string, { bufferedDays: number }>;
  totalGrant: Resources;
  last?: { day: number; mode: 'extraction' | 'recovery'; fade: number; normalProduction: Resources; eligible: Resources; welfare: Resources; grant: Resources; uncovered: Resources };
}
export const extractingAt = (e: Extraction | undefined, day: number) => !!e && e.startedDay <= day && day < e.expiresDay && (e.stoppedDay === undefined || day < e.stoppedDay);
export const supportedAt = (e: Extraction | undefined, day: number) => !!e && e.startedDay <= day && day < e.expiresDay;
export const recoveryFraction = (e: Extraction, day: number) => e.stoppedDay === undefined ? 1 : Math.max(0, Math.min(1, (e.expiresDay-day)/Math.max(1,e.expiresDay-e.stoppedDay)));
export function emergencyView(state: GameState, actor: string) {
  if (!emergencyRules(state)) return null;
  const own=state.factions[actor].extraction;
  const shown=(r:Resources)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v/1000]));
  return {
    rules:V54, available:state.factions[actor].civilization?.choice==='theocracy'&&!own,
    own: own ? { id:own.id, startedDay:own.startedDay, expiresDay:own.expiresDay, stoppedDay:own.stoppedDay,
      phase:state.day>=own.expiresDay?'expired':own.stoppedDay===undefined?'extraction':'recovery',
      remainingDays:Math.max(0,own.expiresDay-state.day), fade:recoveryFraction(own,state.day),
      qualifiedDays:own.qualifiedDays, reformId:own.reformId, totalGrant:shown(own.totalGrant),
      last:own.last?{...own.last,normalProduction:shown(own.last.normalProduction),eligible:shown(own.last.eligible),welfare:shown(own.last.welfare),grant:shown(own.last.grant),uncovered:shown(own.last.uncovered)}:null,
    }:null,
    events:Object.entries(state.factions).flatMap(([target,f])=>{
      const e=f.extraction;if(!e || target!==actor&&e.known[actor]===undefined)return [];
      const knownDay=e.known[actor]??e.startedDay;
      return [{id:e.id,target,startedDay:e.startedDay,expiresDay:e.expiresDay,stoppedDay:e.stoppedDay,
        requestDeadline:Math.max(knownDay,state.factions[actor].civilization?.establishedDay??knownDay)+V54.requestDays,
        demands:e.demands.filter(d=>target===actor||d.actor===actor),reformId:e.reformId,fulfilledDay:e.fulfilledDay}];
    }),
    explanation:'特殊补助无现实来源，非正常生产。只保基础经济，新军备、额外战争维护、维修、冶炼和订单不托底。征收Q最高0.50且整期稳定信仰失格；停止后民生补助在原截止日前渐退。',
  };
}
