import type { Action,GameState } from '../shared/types.js';
import { constructionView } from '../shared/construction.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { StagingArea } from './actions.js';
import { stateChanges } from './planning-delta.js';

export function planningPreview(state:GameState,actor:string,actions:Action[],candidate:ScriptCandidate) {
  const stage=new StagingArea(state,actor);stage.actions=structuredClone(actions);
  for(const action of candidate.actions) {
    const result=stage.execute(action.type,action.args);
    if(!result.ok)return {error:result.error??'条件不满足'};
  }
  if(state.config.scriptStrategy==='adaptive-v4.12') {
    // Compound development targets the future colony, while its production
    // order may be on another, already owned planet. Validate each real queue.
    const targets=new Set(candidate.actions.filter(a=>['build_structure','queue_ships','expand_slots'].includes(a.type)).map(a=>a.args.planetId));
    const old=new Set(state.systems.flatMap(s=>s.projects.map(p=>p.id)));
    const end=state.day+(state.config.maxRounds-state.round)*100;
    for(const target of targets) {
      const system=stage.draft.systems.find(s=>s.planets.some(p=>p.id===target));
      const planet=system?.planets.find(p=>p.id===target);
      if(!system||!planet||!planet.ownerId||!stage.draft.factions[planet.ownerId])return {error:'施工目标缺少有效归属'};
      if(constructionView(stage.draft,system,planet).queues.flatMap(q=>q.projects).some(p=>!old.has(p.id)&&(p.estimatedCompleteDay===null||p.estimatedCompleteDay>end)))return {error:'实际岗位与施工线无法在终局前完工'};
    }
    return {changes:stateChanges(state,stage.draft),actions:stage.actions};
  }
  if(['build','ships','expand'].includes(candidate.kind)||['adaptive-v4','adaptive-v4.1','adaptive-v4.12'].includes(state.config.scriptStrategy??'')&&candidate.actions.some(action=>['build_structure','queue_ships','expand_slots'].includes(action.type))) {
    const system=stage.draft.systems.find(system=>system.planets.some(planet=>planet.id===candidate.target));
    const planet=system?.planets.find(planet=>planet.id===candidate.target);
    const old=new Set(state.systems.flatMap(system=>system.projects.map(project=>project.id)));
    const end=state.day+(state.config.maxRounds-state.round)*100;
    if(system&&planet&&constructionView(stage.draft,system,planet).queues.flatMap(queue=>queue.projects).some(project=>!old.has(project.id)&&(project.estimatedCompleteDay===null||project.estimatedCompleteDay>end)))return {error:'实际岗位与施工线无法在终局前完工'};
  }
  return {changes:stateChanges(state,stage.draft),actions:stage.actions};
}
