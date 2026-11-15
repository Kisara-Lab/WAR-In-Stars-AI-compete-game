import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { srasDecision } from '../dist/sim/sras.js';
import { scriptKnowledge } from '../dist/sim/adaptive-knowledge.js';
import { commitScriptMemory } from '../dist/sim/adaptive-adapter.js';
import { advanceRound } from '../dist/sim/engine.js';
import { SimulationPool } from '../dist/sim/pool.js';
import { stateHash } from '../dist/sim/math.js';
const source='.data/sras-observation-20261116/matches/f9447407-86a9-4439-bddf-a4bd3a5698d4/round-0042.json';
const raw=await readFile(source,'utf8'),saved=JSON.parse(raw),initial=stateHash(saved.state),rows=[];
let state=structuredClone(saved.state);const pool=new SimulationPool(0);
try {
  for(let i=0;i<6;i++) {
    const decisions={};
    for(const actor of ['aurora','verdant']) {
      const known=scriptKnowledge({...state,config:{...state.config,scriptStrategy:'sras-v1'}},actor);
      decisions[actor]=await srasDecision(known,actor,state.factions[actor].scriptMemory);
    }
    rows.push({round:state.round+1,actors:Object.fromEntries(Object.entries(decisions).map(([a,d])=>[a,{openingMinerals:state.factions[a].resources.minerals/1000,actions:d.actions,tasks:d.scriptMemory.sras.tasks,stop:d.scriptReport.sras.stop,blocked:d.scriptReport.sras.blocked}]))});
    state=await advanceRound(state,pool,Object.fromEntries(Object.entries(decisions).map(([a,d])=>[a,d.actions])));commitScriptMemory(state,decisions);
  }
}finally{await pool.close();}
if(await readFile(source,'utf8')!==raw)throw new Error('source snapshot changed');
await mkdir('.data/sras-repair-r42',{recursive:true});
await writeFile('.data/sras-repair-r42/result.json',JSON.stringify({source,initial,note:'Six-round isolated mechanism slice. Opponents wait; not an adversarial match or strength result.',rows,finalHash:stateHash(state)},null,2));
for(const row of rows)console.log(JSON.stringify({round:row.round,actors:Object.fromEntries(Object.entries(row.actors).map(([a,x])=>[a,{minerals:x.openingMinerals,actions:x.actions}]))}));
