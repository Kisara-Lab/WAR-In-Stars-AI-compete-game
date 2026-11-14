import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MatchStore } from '../src/server/storage.js';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { SimulationPool } from '../src/sim/pool.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { governanceView } from '../src/shared/governance.js';
import { ADAPTIVE_V41 } from '../src/shared/adaptive-v41.js';

const argument=(name:string,fallback:string)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const source=argument('--source',''),id=argument('--match','');
if(!source||!id)throw new Error('--source and --match are required; only isolated replays are written');
const output=resolve(argument('--output','.data/verification/adaptive-v41/slices'));
if(output.startsWith(resolve(source)))throw new Error('Output must be outside source saves');
await mkdir(output,{recursive:true});
const store=new MatchStore(source),pool=new PlanningPool(1,{v3:true,computeWorkers:Number(argument('--workers','8')),planningCacheMiB:1024}),simulation=new SimulationPool(0);
const cases=argument('--cases','40:umbra,51:cobalt,63:umbra,64:umbra,65:umbra,66:umbra,67:umbra,64:cobalt,72:cobalt,73:cobalt,76:cobalt').split(',');
const rows:unknown[]=[];
const codeHash=createHash('sha256');
for(const path of ['src/shared/adaptive-v41.ts','src/sim/adaptive-v41.ts','src/sim/adaptive-v41-economy.ts','src/sim/adaptive-v41-military.ts'])codeHash.update(await readFile(path));
const revision=codeHash.digest('hex');
try {
  for(const entry of cases) {
    const [roundText,actor]=entry.split(':'),round=Number(roundText),saved=await store.load(id,round),originalHash=stateHash(saved.state),state=structuredClone(saved.state);
    state.config.scriptStrategy='adaptive-v4.1';state.config.scriptSearchProfile='standard';
    if(state.factions[actor].scriptMemory)state.factions[actor].scriptMemory!.version='adaptive-v4.1'; // Explicit isolated import; not a production migration.
    const started=performance.now(),decisions=await pool.decide(state,undefined,undefined,undefined,[actor]),decision=decisions[actor];
    const nextSaved=await store.load(id,round+1);
    const actions=Object.fromEntries(state.config.factionIds.map(faction=>[faction,faction===actor?decision.actions:nextSaved.lastDecisions?.[faction]?.actions??[]]));
    const next=await advanceRound(state,simulation,actions);
    const failures=next.events.filter(event=>event.round===next.round&&event.type==='order'&&event.audience.includes(actor)&&(event.details as {accepted?:boolean})?.accepted===false);
    const row={round,actor,sourceHash:originalHash,revision,profile:'standard',ms:performance.now()-started,planning:pool.metrics,actions:decision.actions,report:decision.scriptReport,memory:decision.scriptMemory,summary:decision.summary,execution:{failures,score:scoreBreakdown(next,actor),governance:governanceView(next,actor),resources:next.factions[actor].resources,unity:next.factions[actor].unity},baseline:{actions:nextSaved.lastDecisions?.[actor]?.actions,score:scoreBreakdown(nextSaved.state,actor),governance:governanceView(nextSaved.state,actor)},requests:0};
    if(stateHash(saved.state)!==originalHash)throw new Error('Source checkpoint was mutated');
    rows.push(row);await writeFile(join(output,'round-'+round+'-'+actor+'.json'),JSON.stringify(row,null,2));
    await writeFile(join(output,'summary.json'),JSON.stringify({revision,config:ADAPTIVE_V41,rows},null,2));
    console.log(JSON.stringify({round,actor,actions:decision.actions.length,stop:decision.scriptReport?.turn?.stop,risks:[decision.scriptReport?.v4?.risk.value,decision.scriptReport?.v4?.finalRisk.value],military:decision.scriptReport?.v4?.military.slice(0,3).map(option=>({target:option.target,type:option.warType,value:option.value,ready:option.ready,blockers:option.blockers})),failures:failures.length,ms:performance.now()-started}));
  }
} finally {await pool.close();await simulation.close();}
