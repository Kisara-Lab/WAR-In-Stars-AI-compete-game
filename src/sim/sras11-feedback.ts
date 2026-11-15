import type { Action, Decision, GameState } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import { failureCategory, failureDependency } from './sras11-rules.js';
import { scriptKnowledge } from './adaptive-knowledge.js';

export function reconcileSras(state:GameState,actor:string,memory:ScriptMemory,decision:Decision) {
  if(memory.version!=='sras-v1.1'||!memory.sras)return;
  const known=scriptKnowledge(state,actor),m=memory.sras;
  for(const t of m.tasks) {
    const beforeAssets=[...t.assets];
    for(const e of state.events.filter(e=>e.round===state.round&&e.type==='order'&&e.audience.includes(actor))){const d=e.details as {factionId?:string;accepted?:boolean;action?:Action};if(d?.factionId===actor&&d.accepted===true&&d.action?.type==='merge_fleets'){const ids=d.action.args.fleetIds as string[];if(ids.some(id=>beforeAssets.includes(id))&&known.fleets.some(f=>f.ownerId===actor&&f.id===ids[0])){t.assets=[...new Set([...t.assets,ids[0]])];t.lastProgressRound=state.round;delete t.diagnosedRound;}}}
    t.assets=t.assets.filter(id=>known.fleets.some(f=>f.ownerId===actor&&f.id===id));
    const war=known.wars?.find(w=>w.endedDay===undefined&&w.factions.includes(actor)&&w.factions.includes(t.opponent??''));
    if(war){t.warId=war.id;t.warType=war.type;const goal=war.goals[actor]?.find(g=>g.systemId===t.target&&!g.invalid)??war.goals[actor]?.find(g=>!g.invalid);if(goal)t.target=goal.systemId;}
    else if(t.warId){t.stage='exit';t.assets=[];t.exit='actual war ended';}
    if(t.expert==='defense'&&!known.systems.some(h=>h.id===t.target&&h.ownerId===actor&&(h.controllerId??h.ownerId)===actor)){t.stage='exit';t.assets=[];t.reserve={};t.exit='defended territory no longer controlled';}
  }
  for(const event of state.events.filter(e=>e.round===state.round&&e.type==='order'&&e.audience.includes(actor))) {
    const details=event.details as {factionId?:string;accepted?:boolean;action?:Action;reason?:string}|undefined;
    if(details?.factionId!==actor||details.accepted!==false||!details.action)continue;
    const selected=decision.scriptReport?.selected.find(g=>g.actions.some(a=>JSON.stringify(a)===JSON.stringify(details.action)));if(!selected)continue;
    const reason=details.reason??'world rejected action',category=failureCategory(reason);
    m.failures.push({id:selected.id,actions:selected.actions,category,reason,dependency:failureDependency(known,actor,selected.actions,category)});
  }
  for(const t of m.tasks){
    const selected=decision.scriptReport?.sras?.groups.find(g=>g.id===t.plannedGroup&&g.status==='accepted');
    if(selected){const orders=state.events.filter(e=>e.round===state.round&&e.type==='order'&&e.audience.includes(actor)).map(e=>e.details as {factionId?:string;accepted?:boolean;action?:Action});
      if(selected.actions.every(action=>orders.some(e=>e.factionId===actor&&e.accepted===true&&JSON.stringify(e.action)===JSON.stringify(action))))t.status='executed';}
    if(t.warId&&known.wars?.some(w=>w.id===t.warId&&w.endedDay!==undefined))t.status='completed';
  }
  m.failures=m.failures.slice(-64);
  if(decision.scriptReport?.sras){const events=state.events.filter(e=>e.round===state.round&&e.type==='order').map(e=>e.details as {factionId?:string;accepted?:boolean;action?:Action}|undefined).filter(e=>e?.factionId===actor);
    for(const t of m.tasks.filter(t=>t.expert==='campaign'&&t.stage!=='exit'))if(events.some(e=>e?.accepted===true&&e.action?.type==='merge_fleets'&&(e.action.args.fleetIds as string[]).some(id=>t.assets.includes(id)))){t.lastProgressRound=state.round;t.evidence='world confirmed assigned fleet merge';delete t.diagnosedRound;}
    decision.scriptReport.sras.execution={accepted:events.filter(e=>e?.accepted!==false).length,failed:events.filter(e=>e?.accepted===false).length,completedTasks:m.tasks.filter(t=>t.warId&&known.wars?.some(w=>w.id===t.warId&&w.endedDay!==undefined)).map(t=>t.id)};
  }
}
