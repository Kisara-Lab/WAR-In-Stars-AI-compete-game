// Test-only interleaved strategies. No provider imports/configuration/credentials.
import { mkdir,writeFile,readFile,readdir,appendFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../dist/shared/rules.js';
import { PlanningPool } from '../dist/sim/planning-pool.js';
import { SimulationPool } from '../dist/sim/pool.js';
import { createGame } from '../dist/sim/world.js';
import { MatchRunner } from '../dist/server/runner.js';
import { MatchStore } from '../dist/server/storage.js';
import { createApplication } from '../dist/server/app.js';
import { stateHash } from '../dist/sim/math.js';
import { scoreBreakdown } from '../dist/shared/scoring.js';
import { industryPlanet } from '../dist/shared/industry.js';
import { SRAS } from '../dist/shared/sras.js';

const root=resolve('.'),output=resolve(process.argv[2]??'.data/sras-observation');
await mkdir(output,{recursive:false}); // refuse to overwrite or resume the sole observation
const strategies={aurora:'sras-v1',umbra:'adaptive-v4.1',verdant:'sras-v1',cobalt:'adaptive-v4.1'};
const sourceHash=async(dir=join(root,'src'))=>{const hash=createHash('sha256');for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){hash.update(e.name);hash.update(e.isDirectory()?await sourceHash(join(dir,e.name)):await readFile(join(dir,e.name)));}return hash.digest('hex');};
const frozen=await sourceHash(),commit=execFileSync('git',['-c',`safe.directory=${root}`,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const state=createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4.1',scriptSearchProfile:'standard',testScriptStrategies:strategies});
const plan=new PlanningPool(4,{v3:true,computeWorkers:8,planningCacheMiB:512}),simulation=new SimulationPool(4);
const store=new MatchStore(join(output,'matches'),join(output,'session.json'));
const provider=async()=>{throw new Error('SRAS observation prohibits model calls');};
let pending,round=-1,abort=new AbortController(),stopped=false;
const runner=new MatchRunner(state,simulation,store,provider,async(base,actor)=>{
  if(round!==base.round){round=base.round;pending=plan.decide(base,abort.signal,async(actor,input)=>{await writeFile(join(output,`knowledge-${round}-${actor}.json`),JSON.stringify(input));},strategies);}
  return (await pending)[actor];
},false);
await runner.initialize();
const start=runner.start.bind(runner),pause=runner.pause.bind(runner);
runner.pause=()=>{stopped=true;abort.abort();pause();};
runner.start=()=>{throw new Error('Frozen single observation; external restart disabled');};
runner.create=runner.load=async()=>{throw new Error('Frozen observation; cannot create or change match');};
const {server,sockets}=createApplication(runner,provider,root);
const listen=port=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(port);});});
let port;try{port=await listen(8793);}catch(e){if(e.code!=='EADDRINUSE')throw e;port=await listen(8794);}
await writeFile(join(output,'manifest.json'),JSON.stringify({commit,sourceHash:frozen,rulesRevision:SRAS.revision,strategies,config:state.config,port,matchId:state.id,requests:0,tokens:0},null,2));
console.log(JSON.stringify({port,output,matchId:state.id,commit}));
const rows=[],began=performance.now();
try {
  while(!runner.state.result&&!stopped&&runner.state.round<120){
    if(await sourceHash()!==frozen)throw new Error('Source changed: frozen observation paused');
    abort=new AbortController();start(true);await runner.waitIdle();
    if(runner.status.error)throw new Error(runner.status.error);
    if(stopped)break;
    const s=runner.state,decisions=runner.lastDecisions??{};
    const row={round:s.round,hash:stateHash(s),rssMiB:process.memoryUsage().rss/2**20,planning:{...plan.metrics},actors:Object.fromEntries(s.config.factionIds.map(a=>[a,{strategy:strategies[a],actions:decisions[a]?.actions.length??0,stop:decisions[a]?.scriptReport?.sras?.stop??decisions[a]?.scriptReport?.turn?.stop,previews:decisions[a]?.scriptReport?.sras?.previews,ms:decisions[a]?.metrics.durationMs,score:scoreBreakdown(s,a),shortages:s.factions[a].shortages,unity:s.factions[a].unity,welfare:s.factions[a].welfare,responsibility:s.factions[a].responsibility,tasks:s.factions[a].scriptMemory?.sras?.tasks??s.factions[a].scriptMemory?.operation,industry:s.systems.flatMap(x=>x.planets.filter(p=>p.ownerId===a).map(p=>industryPlanet(p,s.day))),queue:s.systems.flatMap(x=>x.projects.filter(p=>p.ownerId===a)),failures:s.events.filter(e=>e.round===s.round&&e.type==='order'&&e.details?.factionId===a&&e.details?.accepted===false).length,cancellations:decisions[a]?.actions.filter(x=>x.type==='cancel_order').length??0}]))};
    for(const a of s.config.factionIds){const d=decisions[a],actor=row.actors[a];actor.rules=d?.scriptReport?.sras;actor.aliveDecision=!!d;actor.territories=s.systems.filter(x=>x.ownerId===a).map(x=>x.id);actor.ships=s.fleets.filter(f=>f.ownerId===a).reduce((n,f)=>n+f.ships.length,0);actor.resources=s.factions[a].resources;actor.warAchievements=s.warAchievements?.filter(x=>x.actor===a&&x.day>s.day-100);}
    rows.push(row);await appendFile(join(output,'rounds.jsonl'),JSON.stringify(row)+'\n');
    if(s.round%20===0||s.result)await writeFile(join(output,`checkpoint-${s.round}.json`),JSON.stringify({rows:rows.slice(-20),state:s,result:s.result}));
    console.log(JSON.stringify({round:s.round,actions:Object.fromEntries(Object.entries(decisions).map(([a,d])=>[a,d.actions.length])),planningMs:plan.metrics.durationMs,rssMiB:row.rssMiB}));
  }
  await runner.save();await writeFile(join(output,'summary.json'),JSON.stringify({round:runner.state.round,stopped,result:runner.state.result,elapsedMs:performance.now()-began,hash:stateHash(runner.state),commit,sourceHash:frozen,requests:0,tokens:0,rows},null,2));
}catch(error){runner.pause();await runner.waitIdle();await runner.save();await writeFile(join(output,'paused-error.json'),JSON.stringify({error:String(error),round:runner.state.round,hash:stateHash(runner.state)},null,2));console.error(error);}
finally{await plan.close();await simulation.close();console.log('Observation stopped and saved; read-only viewer remains on '+port);}
const close=()=>{for(const s of sockets.clients)s.close();server.close();};
process.on('SIGINT',close);process.on('SIGTERM',close);
