import type { ScriptMemory } from '../shared/adaptive.js';
import type { CampaignV41 } from '../shared/adaptive-v41.js';
import type { GameState } from '../shared/types.js';

/** Only reconcile wars involving this actor; unrelated world wars never enter memory. */
export function reconcileWarV41(state:GameState,actor:string,memory:ScriptMemory) {
  if(memory.version!=='adaptive-v4.1'||!memory.operation)return;
  const operation=memory.operation as CampaignV41;
  const actual=state.wars?.find(war=>war.endedDay===undefined&&war.factions.includes(actor)&&war.factions.includes(operation.opponent)&&war.type===operation.warType&&(war.type==='total'||war.goals[actor]?.some(goal=>!goal.invalid&&operation.targets.includes(goal.systemId))));
  if(!actual)return;
  const predictedId=operation.warId;
  operation.warId=actual.id;
  for(const task of memory.tasks)if(task.campaignId===operation.id||predictedId&&task.warId===predictedId)task.warId=actual.id;
  if(operation.completed&&operation.exitReason==='关联战争已结算'){
    operation.completed=false;delete operation.exitReason;operation.stage='attack';
    operation.nextStep='按本方实际战争继续检查声明目标、控制和结算条件';
  }
}
