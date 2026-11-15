import type { Action, Decision, GameState } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';
import { failureCategory, failureDependency } from './sras-rules.js';
import { scriptKnowledge } from './adaptive-knowledge.js';

export function reconcileSras(state:GameState,actor:string,memory:ScriptMemory,decision:Decision) {
  if(memory.version!=='sras-v1'||!memory.sras)return;
  const known=scriptKnowledge(state,actor),m=memory.sras;
  for(const t of m.tasks) {
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
  m.failures=m.failures.slice(-64);
  if(decision.scriptReport?.sras){const events=state.events.filter(e=>e.round===state.round&&e.type==='order').map(e=>e.details as {factionId?:string;accepted?:boolean}|undefined).filter(e=>e?.factionId===actor);decision.scriptReport.sras.execution={accepted:events.filter(e=>e?.accepted!==false).length,failed:events.filter(e=>e?.accepted===false).length,completedTasks:m.tasks.filter(t=>t.stage==='control'||t.stage==='settle'||t.stage==='exit').map(t=>t.id+': '+t.stage)};}
}
