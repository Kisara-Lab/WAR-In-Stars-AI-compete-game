import { emergencyRules, emergencyView } from '../shared/emergency.js';
import { freezeOperations } from '../shared/industry.js';
import { controller } from '../shared/v4.js';
import type { GameState } from '../shared/types.js';
import { processLocal } from './local.js';
import { previewDraft } from './preview.js';
import { economyFactors, settleEconomy } from './engine.js';

/** One ten-day static probe using the exact payment code, on own assets only. */
export function emergencyEconomy(state:GameState,actor:string) {
  if(!emergencyRules(state))return null;
  const probe=(withoutSupport:boolean)=>{
    const draft=previewDraft(state);
    draft.config.factionIds=[actor];draft.factions={[actor]:draft.factions[actor]};
    draft.systems=draft.systems.filter(s=>s.ownerId===actor||controller(s)===actor);
    draft.fleets=draft.fleets.filter(f=>f.ownerId===actor).map(f=>({...f,systemId:draft.systems.some(s=>s.id===f.systemId&&controller(s)===actor)?f.systemId:null}));
    if(withoutSupport)delete draft.factions[actor].extraction;
    freezeOperations(draft);draft.day+=10;const factors=economyFactors(draft);
    const out=processLocal({phase:'economy',day:draft.day,seed:draft.config.seed,systems:draft.systems.filter(s=>controller(s)===actor),fleets:draft.fleets.filter(f=>f.systemId),factions:factors,relations:draft.relations,wars:draft.wars});
    const before={...draft.factions[actor].resources};settleEconomy(draft,[out],factors,false);
    const f=draft.factions[actor];
    return {resourcesPer100:Object.fromEntries(Object.entries(f.resources).map(([k,v])=>[k,(v-(before[k as keyof typeof before]??0))/100])),welfareFraction:f.welfare?.last?.fraction,shortages:f.shortages,receipt:emergencyView(draft,actor)?.own?.last??null};
  };
  return {asOfDay:state.day,current:probe(false),withoutSubsidy:probe(true),assumptions:'本方当前设施、人口与舰船不变的十日精确支付试算，折合每100日；库存钳制会使实际变化为0而不是负数，须同时查看shortages和福利兑现。无补助列不假设未来社会恢复；720/1440预测另含原期限退出。'};
}
