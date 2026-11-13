import {ADAPTIVE} from '../shared/adaptive.js';
import type {GameState} from '../shared/types.js';
import {resourcePurposes} from './industry.js';

export function adaptiveResourceWeights(state:GameState,actor:string,purpose=resourcePurposes(state,actor)) {
  const safety=Math.min(ADAPTIVE.safetyDays,(state.config.maxRounds-state.round)*100);
  return Object.fromEntries(purpose.resources.map(item=>{
    let weight:number=ADAPTIVE.rawMaterialWeight;
    if(item.resource==='energy'||item.resource==='food')weight=item.stock+Math.min(item.netPer100,item.afterQueuedNetPer100)*Math.min(ADAPTIVE.horizons[0],(state.config.maxRounds-state.round)*100)/100<0?ADAPTIVE.supplyWeight:0;
    else if(item.resource==='alloys')weight=purpose.processing.afterQueued.alloyOutput>0&&purpose.afterQueuedDestroyerMaterialCapacityPer100<=0?ADAPTIVE.rawMaterialWeight:ADAPTIVE.alloyWeight;
    else if(purpose.reserveScoreRemaining===0&&item.afterQueuedNetPer100>2*purpose.processing.afterQueued.alloyOutput)weight=ADAPTIVE.surplusWeight;
    return [item.resource,weight];
  }));
}
