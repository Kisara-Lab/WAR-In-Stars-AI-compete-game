import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const root=resolve(process.argv[2]??'.data/sras-rules3-replacement'),out=resolve(process.argv[3]??'.data/sras-rules5-audit');
await mkdir(out,{recursive:true});
const rows=[],hashes={};
for(const id of await readdir(join(root,'matches')))for(const file of (await readdir(join(root,'matches',id))).filter(x=>/^round-\d+\.json$/.test(x)).sort()){
 const path=join(root,'matches',id,file),raw=await readFile(path),v=JSON.parse(raw),s=v.state;hashes[path]=createHash('sha256').update(raw).digest('hex');
 for(const actor of s.config.factionIds){const d=v.decisions?.[actor],systems=s.systems.filter(x=>x.ownerId===actor),fleets=s.fleets.filter(f=>f.ownerId===actor),changes=new Map(),reversals=[];
  for(const action of d?.actions??[]){const key=action.type==='set_structure_status'?'structure:'+action.args.structureId:action.type==='set_jobs'?'jobs:'+action.args.planetId+':'+action.args.structureType:null;if(key){if(changes.has(key))reversals.push({key,previous:changes.get(key),action});changes.set(key,action);}}
  rows.push({settledRound:s.round,decisionBoundary:s.round-1,actor,actions:d?.actions??[],decided:!!d,previews:d?.scriptReport?.sras?.previews,stop:d?.scriptReport?.sras?.stop,reversals,blocked:d?.scriptReport?.sras?.blocked,tasks:d?.scriptMemory?.sras?.tasks,resources:s.factions[actor].resources,unity:s.factions[actor].unity,shortages:s.factions[actor].shortages,systems:systems.map(x=>x.id),ships:fleets.reduce((n,f)=>n+f.ships.length,0),idleFleets:fleets.filter(f=>!f.order&&!f.transit).length,planets:systems.flatMap(x=>x.planets.filter(p=>p.ownerId===actor).map(p=>({id:p.id,population:p.population,operation:p.operation,structures:p.structures}))),queues:systems.flatMap(x=>x.projects),events:s.events.filter(e=>e.round===s.round),warAchievements:s.warAchievements?.filter(x=>x.day>s.day-100)});
 }
}
await writeFile(join(out,'baseline.json'),JSON.stringify({source:root,hashes,rows}));
console.log(JSON.stringify({snapshots:Object.keys(hashes).length,rows:rows.length,reversals:rows.filter(r=>r.reversals.length).map(r=>({round:r.settledRound,actor:r.actor,count:r.reversals.length})),emptySurvivorDecisions:rows.filter(r=>r.decided&&!r.actions.length&&r.systems.length).map(r=>({round:r.settledRound,actor:r.actor}))}));
