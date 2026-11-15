// Replay planning only from the last committed boundary. Never save or simulate.
import {readFile} from 'node:fs/promises';
import {PlanningPool} from '../dist/sim/planning-pool.js';
const root='.data/sras11-observation',m=JSON.parse(await readFile(root+'/manifest.json','utf8'));
const turn=JSON.parse(await readFile(root+'/matches/'+m.matchId+'/round-0021.json','utf8'));
const pool=new PlanningPool(4,{v3:true,computeWorkers:Number(process.argv[2]??0),planningCacheMiB:512});
try{const d=await pool.decide(turn.state,undefined,undefined,m.strategies);console.log(Object.fromEntries(Object.entries(d).map(([a,x])=>[a,x.actions.length])));}
catch(e){console.error(e.stack);process.exitCode=1;}finally{await pool.close();}
