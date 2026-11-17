import type { GameState } from '../shared/types.js';
import type { V3Coverage } from './adaptive-v3-values.js';
import { positionValueV4 } from './adaptive-v4-values.js';
import { ADAPTIVE_V415Final } from '../shared/adaptive-v415final.js';
import { CIVILIZATION, route } from '../shared/civilization.js';

export function institutionalOption(state:GameState,actor:string,endDay:number) {
  const own=state.factions[actor],welfare=own.welfare;
  if(route(state,actor)!=='secular'||welfare?.choice!=='utopian'||welfare.last?.fraction!==1||Object.values(own.shortages).some(Boolean))return 0;
  const qualified=welfare.history.filter(entry=>entry.qualified).length/72;
  const eligibleDay=Math.max(state.day,(welfare.highestSince??state.day)+CIVILIZATION.qualificationDays);
  const firstAward=(Math.floor(eligibleDay/720)+2)*720;
  return endDay>=firstAward?50*Math.min(1,qualified):0;
}

/** Stocks already appear in the real reserve score. Only usable future capacity
 * is an additional option value; spending stocks on real ships is not taxed twice. */
export function positionValueV415Final(state:GameState,actor:string,endDay:number,coverage:V3Coverage={}) {
  const value=positionValueV4(state,actor,endDay,coverage),own=state.factions[actor];
  const days=Math.max(0,Math.min(720,endDay-state.day));value.economy=0;
  for(const resource of ['energy','food','minerals','alloys'] as const) {
    const unfilled=Math.max(0,value.uses[resource]-(own.resources[resource]??0)/1000);
    const usable=Math.min(unfilled,Math.max(0,value.net[resource])*days/100);
    value.economy+=usable*(resource==='alloys'?2:1)*ADAPTIVE_V415Final.investmentValue;
  }
  return {...value,institutionOption:institutionalOption(state,actor,endDay)};
}


