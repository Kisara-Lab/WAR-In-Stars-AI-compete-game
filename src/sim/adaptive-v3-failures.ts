import { createHash } from 'node:crypto';
import type { Action,GameState } from '../shared/types.js';
import { accessiblePath } from './diplomacy.js';
import { STRUCTURES, type StructureType, type ShipType } from '../shared/rules.js';
import { LABOR, shipMaterials } from '../shared/industry.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function v3FailureDependency(state:GameState,actor:string,actions:Action[],reason:string) {
  const own=state.factions[actor];
  if(/资源|不足|费用|余额/.test(reason)) {
    const required=new Set<string>();
    for(const action of actions) {
      if(['set_jobs','set_structure_status','choose_policy','set_welfare','move_fleet'].includes(action.type))continue;
      if(['survey_system','build_starbase','create_claim'].includes(action.type))required.add('minerals');
      else if(action.type==='build_structure'&&typeof action.args.structureType==='string'&&action.args.structureType in STRUCTURES) {
        const type=action.args.structureType as StructureType;
        if(STRUCTURES[type].minerals>0)required.add('minerals');
        if(LABOR[type].alloys>0)required.add('alloys');
      } else if(action.type==='queue_ships') {
        for(const [resource,cost] of Object.entries(shipMaterials(action.args.shipType as ShipType)))if(cost>0)required.add(resource);
      } else if(['colonize_planet','consecrate','prepare_conquest'].includes(action.type)) {
        required.add('minerals');required.add('food');
      } else if(action.type==='expand_slots') {
        required.add('minerals');required.add('alloys');
      } else for(const resource of Object.keys(own.resources))required.add(resource);
    }
    return digest({actions,resources:Object.fromEntries([...required].sort().map(resource=>[resource,own.resources[resource as keyof typeof own.resources]])),...(actions.some(action=>action.type==='prepare_conquest')?{unity:own.unity,civilization:own.civilization?.choice}:{})});
  }
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
