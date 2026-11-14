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
  if(['build','ships','expand'].includes(candidate.kind)) {
    const system=stage.draft.systems.find(system=>system.planets.some(planet=>planet.id===candidate.target));
    const planet=system?.planets.find(planet=>planet.id===candidate.target);
    const old=new Set(state.systems.flatMap(system=>system.projects.map(project=>project.id)));
    const end=state.day+(state.config.maxRounds-state.round)*100;
    if(system&&planet&&constructionView(stage.draft,system,planet).queues.flatMap(queue=>queue.projects).some(project=>!old.has(project.id)&&(project.estimatedCompleteDay===null||project.estimatedCompleteDay>end)))return {error:'实际岗位与施工线无法在终局前完工'};
  }
  return {changes:stateChanges(state,stage.draft),actions:stage.actions};
}
