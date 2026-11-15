import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scriptKnowledge} from '../dist/sim/adaptive-knowledge.js';
import {srasDecision} from '../dist/sim/sras.js';
import {conflictKeys} from '../dist/sim/sras-response.js';
import {advanceRound} from '../dist/sim/engine.js';
import {SimulationPool} from '../dist/sim/pool.js';
import {commitScriptMemory} from '../dist/sim/adaptive-adapter.js';
import {stateHash} from '../dist/sim/math.js';
const root='.data/sras-rules3-replacement/matches',dir=root+'/'+(await readdir(root))[0],out='.data/sras-rules5-audit';
await mkdir(out,{recursive:true});const rows=[],pool=new SimulationPool(0);
try{for(const round of [19,34,40,41,42,43,44,45,46,47,50,60,80]){
 const path=`${dir}/round-${String(round-1).padStart(4,'0')}.json`,raw=await readFile(path),before=JSON.parse(raw).state,hash=createHash('sha256').update(raw).digest('hex');
 const old=JSON.parse(await readFile(`${dir}/round-${String(round).padStart(4,'0')}.json`)),decisions={};
 for(const actor of ['aurora','verdant']){if(!old.decisions[actor])continue;
  const d=await srasDecision(scriptKnowledge(before,actor),actor,before.factions[actor].scriptMemory);decisions[actor]=d;
  const keys=d.actions.flatMap(conflictKeys);if(new Set(keys).size!==keys.length)throw Error(`conflicting keys ${round}/${actor}`);
  if(d.actions.length>48||d.scriptReport.sras.previews>128)throw Error('budget violation');
  rows.push({round,actor,sourceHash:hash,oldActions:old.decisions[actor].actions.length,actions:d.actions,report:d.scriptReport.sras});
 }
 const actual=await advanceRound(structuredClone(before),pool,Object.fromEntries(Object.entries(decisions).map(([a,d])=>[a,d.actions])));commitScriptMemory(actual,decisions);
 for(const r of rows.filter(r=>r.round===round)){r.executedHash=stateHash(actual);r.execution=decisions[r.actor].scriptReport.sras.execution;r.note='Independent one-round mechanism slice; opponents wait, not a match-strength result';}
 if(createHash('sha256').update(await readFile(path)).digest('hex')!==hash)throw Error('Source changed');
}}
finally{await pool.close();}
await writeFile(out+'/slices.json',JSON.stringify(rows,null,2));
console.log(JSON.stringify(rows.map(r=>({round:r.round,actor:r.actor,old:r.oldActions,actions:r.actions.length,previews:r.report.previews,situation:r.report.situation,stop:r.report.stop,execution:r.execution}))));
