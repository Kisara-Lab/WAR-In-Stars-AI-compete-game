import { previewDraft } from './preview.js';
import type { Action, GameState } from '../shared/types.js';
import { applyAction } from './actions.js';
import { distance } from './math.js';
import { RULES } from '../shared/rules.js';

/** An isolated known world, never a shortcut to live foreign facilities or projects. */
export function knownActionWorld(state: GameState, actor: string) {
  const draft=previewDraft(state), f=state.factions[actor];
  const fleets=new Map(state.fleets.filter(f=>f.ownerId===actor).map(f=>[f.id,{fleet:f,day:state.day}]));
  for(const memory of [...Object.values(f.intel),...Object.values(f.militaryIntel??{})]) for(const fleet of memory.fleets) {
    if(fleet.ownerId!==actor&&(fleets.get(fleet.id)?.day??-1)<=memory.day) fleets.set(fleet.id,{fleet,day:memory.day});
  }
  draft.fleets=structuredClone([...fleets.values()].map(f=>f.fleet));
  draft.systems=draft.systems.map(s=>{
    if(s.ownerId===actor) return s;
    const intel=f.intel[s.id],military=f.militaryIntel?.[s.id];
    const known=intel?structuredClone(intel.system):{...s,ownerId:null,controllerId:undefined,base:null,planets:[],projects:[]};
    if(military&&military.day>=(intel?.day??-1)) { known.ownerId=military.ownerId;known.controllerId=military.controllerId;known.base=structuredClone(military.base); }
    known.projects=s.projects.filter(p=>p.ownerId===actor);
    return known;
  });
  return draft;
}

export function actionability(state: GameState, actor: string) {
  const world=knownActionWorld(state,actor), f=world.factions[actor];
  const check=(action:Action)=>{
    try{applyAction(previewDraft(world),actor,action,'availability-preview',false);return {action,allowed:true,blocker:null};}
    catch(e){return {action,allowed:false,blocker:e instanceof Error?e.message:String(e)};}
  };
  const own=world.fleets.filter(f=>f.ownerId===actor);
  return {day:state.day,source:'本方领土、队列及带日期的实际情报；allowed仅为当前已知条件，通过后仍在共同结算复核隐藏变化',
    systems:world.systems.map(s=>({systemId:s.id,lastSeenDay:s.ownerId===actor?state.day:Math.max(f.intel[s.id]?.day??-1,f.militaryIntel?.[s.id]?.day??-1),
      survey:check({type:'survey_system',args:{systemId:s.id}}),
      base:f.surveyed.includes(s.id)?check({type:'build_starbase',args:{systemId:s.id}}):{allowed:false,blocker:'必须先完成探索'},
      colonies:f.surveyed.includes(s.id)&&s.ownerId===actor?s.planets.map(p=>check({type:'colonize_planet',args:{planetId:p.id}})):[]})),
    exploration:world.systems.flatMap(s=>s.projects.filter(p=>p.ownerId===actor&&p.kind==='survey').map(p=>({id:p.id,systemId:s.id,completionDay:state.day+Math.ceil(Math.max(0,p.requiredDays-p.progress/1000)/RULES.tickDays)*RULES.tickDays,reveals:'完成后揭示设施、禀赋及是否存在候选；现在不能预知结果'}))),
    merges:own.flatMap((a,i)=>own.slice(i+1).map(b=>({fleetIds:[a.id,b.id],sameSystem:!!a.systemId&&a.systemId===b.systemId,distance:distance(a.position,b.position),...check({type:'merge_fleets',args:{fleetIds:[a.id,b.id]}})})))};
}
