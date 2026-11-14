import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/shared/rules.js';
import { ADAPTIVE_V4 } from '../src/shared/adaptive-v4.js';
import { createGame } from '../src/sim/world.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { SimulationPool } from '../src/sim/pool.js';
import { advanceRound } from '../src/sim/engine.js';
import { commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { stateHash } from '../src/sim/math.js';

const directory=resolve(process.argv[2]??'.data/verification/adaptive-v4/opening-repair');
const rounds=Number(process.argv[3]??16);
await mkdir(directory,{recursive:true});
let state=createGame({...structuredClone(DEFAULT_CONFIG),seed:'stars-2026',systemCount:24,maxRounds:120,controller:'scripted',scriptStrategy:'adaptive-v4',scriptSearchProfile:'standard'},'v4-opening-check');
const planning=new PlanningPool(1,{v3:true,computeWorkers:8,planningCacheMiB:512}),simulation=new SimulationPool(0);
const rows:unknown[]=[];
try {
  for(let index=0;index<rounds;index++) {
    const decisions=await planning.decide(state);
    const next=await advanceRound(state,simulation,Object.fromEntries(Object.entries(decisions).map(([id,decision])=>[id,decision.actions])));
    commitScriptMemory(next,decisions);state=next;
    const row={round:state.round,hash:stateHash(state),factions:state.config.factionIds.map(id=>({id,actions:decisions[id].actions,stop:decisions[id].scriptReport?.turn?.stop,report:decisions[id].scriptReport,systems:state.systems.filter(s=>s.ownerId===id).length,colonies:state.systems.flatMap(s=>s.planets).filter(p=>p.ownerId===id).length,surveyed:state.factions[id].surveyed.length,resources:state.factions[id].resources,shortages:state.factions[id].shortages,projects:state.systems.flatMap(s=>s.projects).filter(p=>p.ownerId===id).map(p=>({kind:p.kind,progress:p.progress,planet:p.planetId}))}))};
    rows.push(row);await writeFile(join(directory,'round-'+state.round+'.json'),JSON.stringify({state,decisions},null,2));
    await writeFile(join(directory,'summary.json'),JSON.stringify({revision:ADAPTIVE_V4.revision,requests:0,rows},null,2));
    console.log(JSON.stringify({...row,factions:row.factions.map(({report,...f})=>({...f,actions:f.actions.map(a=>a.type+':'+JSON.stringify(a.args)),risk:report?.v4?.finalRisk.value,forecasts:report?.forecasts}))}));
  }
  if(rounds>=16)for(const id of ['umbra','cobalt']) {
    if(state.systems.filter(s=>s.ownerId===id).length<2||state.systems.flatMap(s=>s.planets).filter(p=>p.ownerId===id).length<2)throw new Error(id+' opening expansion chain did not complete');
  }
} finally {await planning.close();await simulation.close();}
