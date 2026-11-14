import fs from 'node:fs';
import {PlanningPool} from '../.data/verification/v412-national-capacity-6/runtime/dist/sim/planning-pool.js';
const root='.data/live-v412-capacity-5-60-20261115/matches/99bad0cf-2dbc-4d25-9268-36480d30b746';
const pool=new PlanningPool(1,{v3:true,computeWorkers:8,planningCacheMiB:1024}); const rows=[];
try{for(const [round,actor] of [[19,'cobalt'],[35,'umbra'],[40,'umbra']]){const file=root+'/round-'+String(round).padStart(4,'0')+'.json',raw=fs.readFileSync(file,'utf8'),s=JSON.parse(raw).state; const ds=await pool.decide(s,undefined,undefined,undefined,[actor]); const d=ds[actor]; rows.push({round,actor,actions:d.actions,report:d.scriptReport}); console.log(JSON.stringify({round,actor,actions:d.actions,stop:d.scriptReport?.turn?.stop}));if(fs.readFileSync(file,'utf8')!==raw)throw Error('source changed');}fs.writeFileSync('.data/verification/v412-national-capacity-6/slices.json',JSON.stringify(rows,null,2));}finally{await pool.close();}
