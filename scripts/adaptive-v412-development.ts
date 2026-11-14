import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { SimulationPool } from '../src/sim/pool.js';
import { advanceRound } from '../src/sim/engine.js';
import { commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { stateHash } from '../src/sim/math.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { ADAPTIVE_V412 } from '../src/shared/adaptive-v412.js';
import type { GameState, Action } from '../src/shared/types.js';

// One short, counterfactual opening. Reuses recorded model orders, never a provider.
const source='.data/live-adaptive-v412-20261115/matches/cfec36aa-b8cd-4569-bd07-e51d51b445b8';
const hashes:Record<string,string>={};
const load=async(round:number)=>{
  const file=join(source,round===0?'initial.json':`round-${String(round).padStart(4,'0')}.json`),raw=await readFile(file);
  hashes[file]=createHash('sha256').update(raw).digest('hex');return JSON.parse(raw.toString());
};
const digest=createHash('sha256');
for(const p of (await readdir('src/sim')).filter(p=>p.startsWith('adaptive-v412')).sort())digest.update(await readFile(join('src/sim',p)));
digest.update(await readFile('src/shared/adaptive-v412.ts'));
const revision=digest.digest('hex'),out=join('.data/verification/adaptive-v412/development',revision.slice(0,12));
await mkdir(out,{recursive:true});
const fromIndex=process.argv.indexOf('--from'),untilIndex=process.argv.indexOf('--until');
const prefix=fromIndex>=0?process.argv[fromIndex+1]:undefined;
const until=untilIndex>=0?Number(process.argv[untilIndex+1]):15;
let state:GameState=prefix?JSON.parse(await readFile(prefix,'utf8')).state:(await load(0)).state;
const startRound=state.round;
const planning=new PlanningPool(2,{v3:true,computeWorkers:2,planningCacheMiB:512}),simulation=new SimulationPool(0),rows:unknown[]=[];
try {
  for(let round=startRound+1;round<=until;round++) {
    const original=await load(round),before=stateHash(state);
    if(!original.decisions)throw Error('Missing recorded model orders');
    const decisions=await planning.decide(state,undefined,undefined,undefined,['umbra','cobalt']);
    const actions:Record<string,Action[]>=Object.fromEntries(state.config.factionIds.map(id=>[id,decisions[id]?.actions??original.decisions[id]?.actions??[]]));
    const next=await advanceRound(state,simulation,actions);commitScriptMemory(next,decisions);
    if(stateHash(state)!==before)throw Error('Source mutated during planning');
    const summary=(s:GameState,id:string)=>({systems:s.systems.filter(x=>x.ownerId===id).length,colonies:s.systems.flatMap(x=>x.planets).filter(p=>p.ownerId===id).length,population:s.systems.flatMap(x=>x.planets).filter(p=>p.ownerId===id).reduce((n,p)=>n+p.population,0),ships:s.fleets.filter(f=>f.ownerId===id).reduce((n,f)=>n+f.ships.length,0),score:scoreBreakdown(s,id).total,welfare:s.factions[id].welfare?.choice,resources:s.factions[id].resources,projects:s.systems.flatMap(x=>x.projects.filter(p=>p.ownerId===id)),shortages:s.factions[id].shortages});
    const row={round,hash:stateHash(next),factions:['umbra','cobalt'].map(id=>({id,...summary(next,id),actions:decisions[id].actions,report:decisions[id].scriptReport,memory:decisions[id].scriptMemory,baseline:summary(original.state,id)})),failures:next.events.filter(e=>e.round===round&&e.type==='order'&&(e.details as {accepted?:boolean})?.accepted===false)};
    rows.push(row);await writeFile(join(out,`round-${round}.json`),JSON.stringify({state:next,decisions,orders:actions,row}));
    console.log(JSON.stringify({round,factions:row.factions.map(f=>({id:f.id,actions:f.actions.length,colonies:f.colonies,systems:f.systems,ships:f.ships,welfare:f.welfare,next:f.memory?.v412?.development?.next})),failures:row.failures.length}));
    state=next;
  }
  for(const [file,hash] of Object.entries(hashes))if(createHash('sha256').update(await readFile(file)).digest('hex')!==hash)throw Error('Historical file changed');
  await writeFile(join(out,'summary.json'),JSON.stringify({revision,configRevision:ADAPTIVE_V412.revision,requests:0,prefix,startRound,method:'short counterfactual with historical model orders; models do not respond to changed play; any repaired prefix is identified separately',sourceHashes:hashes,rows}));
} finally {await planning.close();await simulation.close();}
