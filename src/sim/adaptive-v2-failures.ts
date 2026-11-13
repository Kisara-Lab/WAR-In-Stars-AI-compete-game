import { createHash } from 'node:crypto';
import type { Action, GameState } from '../shared/types.js';
import { controller } from '../shared/v4.js';

export function failureConditions(state:GameState,actor:string,actions:Action[]) {
  const own=state.factions[actor];
  const conditions=actions.map(action=>{
    const system=state.systems.find(system=>system.id===action.args.systemId||system.planets.some(planet=>planet.id===action.args.planetId));
    const planet=system?.planets.find(planet=>planet.id===action.args.planetId);
    const fleet=state.fleets.find(fleet=>fleet.ownerId===actor&&fleet.id===action.args.fleetId);
    const related=new Set([action.args.factionId,system?.ownerId,system?controller(system):undefined]);
    if(fleet?.systemId&&system) {
      const paths=[[fleet.systemId]],seen=new Set<string>();
      while(paths.length) {
        const path=paths.shift()!,last=path.at(-1)!;
        if(seen.has(last))continue;seen.add(last);
        if(last===system.id){for(const id of path){const sector=state.systems.find(item=>item.id===id);if(sector)related.add(controller(sector));}break;}
        const sector=state.systems.find(item=>item.id===last);
        for(const next of [...sector?.neighbors??[]].sort())if(!seen.has(next))paths.push([...path,next]);
      }
    }
    return {
      action,system:system?{id:system.id,owner:system.ownerId,controller:controller(system),base:!!system.base}:undefined,
      colonyDay:system?own.intel[system.id]?.day:undefined,
      planet:planet?{owner:planet.ownerId,structures:planet.structures,priorities:planet.priorities,population:planet.population}:undefined,
      fleet,projects:state.systems.flatMap(system=>system.projects).filter(project=>project.id===action.args.projectId||project.planetId===action.args.planetId).map(project=>({id:project.id,kind:project.kind,structureType:project.structureType})),
      relations:Object.values(state.relations).filter(relation=>relation.factions.includes(actor)&&relation.factions.some(id=>id!==actor&&related.has(id))).map(relation=>({factions:relation.factions,status:relation.status,access:relation.access,pactActive:!!relation.pactUntil&&relation.pactUntil>state.day}))
    };
  });
  return createHash('sha256').update(JSON.stringify(conditions)).digest('hex');
}
