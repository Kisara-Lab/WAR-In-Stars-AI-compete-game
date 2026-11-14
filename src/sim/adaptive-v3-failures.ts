import { createHash } from 'node:crypto';
import type { Action,GameState } from '../shared/types.js';
import { accessiblePath } from './diplomacy.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function v3FailureDependency(state:GameState,actor:string,actions:Action[],reason:string) {
  const own=state.factions[actor];
  if(/资源|不足|费用|余额/.test(reason))return digest({actions,resources:own.resources});
  if(/舰队|fleet/i.test(reason))return digest(actions.map(action=>state.fleets.filter(fleet=>fleet.ownerId===actor&&(fleet.id===action.args.fleetId||(action.args.fleetIds as string[]|undefined)?.includes(fleet.id)))));
  if(/通行|闭境|边境|路径/.test(reason))return digest(actions.map(action=>{
    const fleet=state.fleets.find(fleet=>fleet.ownerId===actor&&fleet.id===action.args.fleetId),target=state.systems.find(system=>system.id===action.args.systemId);
    if(fleet?.systemId&&target)return {fleetId:fleet.id,from:fleet.systemId,to:target.id,path:accessiblePath(state,actor,fleet.systemId,target.id)};
    return {action,relation:Object.values(state.relations).find(relation=>relation.factions.includes(actor)&&relation.factions.includes(String(action.args.factionId)))};
  }));
  return digest(actions.map(action=>{
    const system=state.systems.find(system=>system.id===action.args.systemId||system.planets.some(planet=>planet.id===action.args.planetId));
    return {action,intel:system?own.intel[system.id]:undefined,own:system?.ownerId===actor?{ownerId:system.ownerId,projects:system.projects.map(project=>({id:project.id,kind:project.kind})),planets:system.planets.map(planet=>({id:planet.id,ownerId:planet.ownerId,structures:planet.structures,priorities:planet.priorities}))}:undefined};
  }));
}
