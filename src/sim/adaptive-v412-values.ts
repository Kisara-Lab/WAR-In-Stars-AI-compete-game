import type { GameState } from '../shared/types.js';
import type { V3Coverage } from './adaptive-v3-values.js';
import { positionValueV4 } from './adaptive-v4-values.js';
import { ADAPTIVE_V412 } from '../shared/adaptive-v412.js';

/** Stocks already appear in the real reserve score. Only usable future capacity
 * is an additional option value; spending stocks on real ships is not taxed twice. */
export function positionValueV412(state:GameState,actor:string,endDay:number,coverage:V3Coverage={}) {
  const value=positionValueV4(state,actor,endDay,coverage),own=state.factions[actor];
  const days=Math.max(0,Math.min(720,endDay-state.day));value.economy=0;
  for(const resource of ['energy','food','minerals','alloys'] as const) {
    const unfilled=Math.max(0,value.uses[resource]-(own.resources[resource]??0)/1000);
    const usable=Math.min(unfilled,Math.max(0,value.net[resource])*days/100);
    value.economy+=usable*(resource==='alloys'?2:1)*ADAPTIVE_V412.investmentValue;
  }
  return value;
}
