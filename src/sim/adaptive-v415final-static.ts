import type { GameState } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import type { economicForecast } from './forecast.js';
import { policyComparison } from '../shared/comparison.js';
import { industryPlanet, LABOR } from '../shared/industry.js';
import { STRUCTURES, SHIPS } from '../shared/rules.js';
import { v3StaticTimeline } from './adaptive-v3-values.js';
import { positionValueV415Final } from './adaptive-v415final-values.js';

/** Conservative residual admission: prepaid cost plus full upkeep, no future output
 * credited to the safety bound. Exact full-plan forecast still follows. */
export function independentBoundV415Final(before:GameState,after:GameState,actor:string,candidate:ScriptCandidate,projection:ReturnType<typeof economicForecast>) {
  if(!candidate.actions.every(a=>['queue_ships','build_structure','set_jobs','set_structure_status'].includes(a.type)))return null;
  if(projection.trajectory?.some(t=>(t.risk?.shortageDays??0)>0||(t.causes?.fundingSeverity??0)>0))return null;
  const keys=['energy','food','minerals','alloys'] as const;
  const quote=(s:GameState)=>policyComparison(s,actor,[s.factions[actor].policy?.choice??'none'])[0];
  const q0=quote(before),q1=quote(after);
  const extra={energy:0,food:0,minerals:0,alloys:0};
  const oldProjects=new Set(before.systems.flatMap(s=>s.projects.map(p=>p.id)));
  for(const system of after.systems)for(const p of system.projects.filter(p=>!oldProjects.has(p.id)&&p.ownerId===actor)) {
    if(p.kind==='ship'&&p.shipType){extra.energy+=SHIPS[p.shipType].energy*2;extra.minerals+=SHIPS[p.shipType].upkeep*2;}
    if(p.kind==='building'&&p.structureType) {
      const planet=system.planets.find(x=>x.id===p.planetId)!;
      const labor=industryPlanet({...planet,operation:undefined},after.day);
      const jobs=system.projects.filter(x=>x.planetId===planet.id&&x.kind==='building'&&x.structureType).reduce((n,x)=>n+LABOR[x.structureType!].jobs,0);
      if(labor.population-labor.employed<jobs)return null;
      if(['housing','habitat','hospital','agriculture','foundry','solar_hub','refinery'].includes(p.structureType))return null;
      extra.energy+=STRUCTURES[p.structureType].energy;extra.minerals+=STRUCTURES[p.structureType].upkeep;
    }
  }
  const adjustment=Object.fromEntries(keys.map(k=>[k,Math.max(0,((before.factions[actor].resources[k]??0)-(after.factions[actor].resources[k]??0))/1000)]));
  for(const row of projection.horizons)for(const resource of keys) {
    const loss=adjustment[resource]+(extra[resource]+Math.max(0,q0.net[resource]-q1.net[resource]))*row.days/100;
    if(row.resources[resource]-loss<Math.max(1,resource==='alloys'?0:q1.upkeep[resource]))return null;
  }
  const days=Math.min(720,(after.config.maxRounds-after.round)*100);
  const a=v3StaticTimeline(before,actor,days,{},positionValueV415Final),b=v3StaticTimeline(after,actor,days,{},positionValueV415Final);
  const gain=(b.score+b.economy+b.functional)-(a.score+a.economy+a.functional);
  if(gain<=.01||b.shortageDays>a.shortageDays||b.unpaidDays>a.unpaidDays)return null;
  const bounded=structuredClone(projection);
  for(const row of bounded.horizons)for(const k of keys)row.resources[k]-=adjustment[k]+(extra[k]+Math.max(0,q0.net[k]-q1.net[k]))*row.days/100;
  return {projection:bounded,gain,adjustment,extra};
}


