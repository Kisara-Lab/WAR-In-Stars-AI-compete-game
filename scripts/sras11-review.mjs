// Read every saved decision and event; observers' data never goes to a planner.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readJournal} from '../dist/server/audit.js';
const source=process.argv[2]??'.data/sras-rules5-observation',out=process.argv[3]??'.data/sras11-review-rules5';
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
const dir=join(source,'matches',manifest.matchId),files=(await readdir(dir)).filter(f=>/^round-\d{4}\.json$/.test(f)).sort();
const rows=[],hashes={},events=new Map();
for(const file of files){
  const raw=await readFile(join(dir,file));hashes[file]=createHash('sha256').update(raw).digest('hex');const turn=JSON.parse(raw);
  for(const e of turn.state.events)if(['battle','war','elimination'].includes(e.type))events.set(e.id,e);
  for(const [actor,d]of Object.entries(turn.decisions)){
    const r=d.scriptReport?.sras,actions=d.actions;
    const worlds=turn.state.events.filter(e=>e.round===turn.round&&e.type==='order'&&e.details?.factionId===actor);
    rows.push({round:turn.round,boundary:turn.round-1,actor,strategy:d.scriptReport?.version,actions:actions.length,previews:r?.previews,stop:r?.stop,budget:r?.budget,counters:r?.counters,netChanges:r?.netChanges,taskStages:r?.tasks?.map(t=>({id:t.id,stage:t.stage,next:t.next,blockers:t.blockers,assets:t.assets,lastProgress:t.lastProgressRound})),accepted:worlds.filter(e=>e.details?.accepted===true).length,failed:worlds.filter(e=>e.details?.accepted===false).length,commands:actions.reduce((counts,a)=>(counts[a.type]=(counts[a.type]??0)+1,counts),{}),rejections:r?.blocked?.reduce((counts,b)=>(counts[b.reason]=(counts[b.reason]??0)+1,counts),{})});
  }
}
// Journal covers events evicted from snapshot event windows.
await readJournal(join(dir,'audit.jsonl'),r=>{if(r.category.startsWith('event.')&&['battle','war','elimination'].includes(r.data?.type))events.set(r.data.id,r.data);return false;});
await mkdir(out,{recursive:true});
await writeFile(join(out,'review.json'),JSON.stringify({sourceCommit:manifest.commit,sourceHash:manifest.sourceHash,roundFiles:files.length,decisions:rows.length,hashes,rows,events:[...events.values()]},null,2));
for(const file of files)if(createHash('sha256').update(await readFile(join(dir,file))).digest('hex')!==hashes[file])throw Error('Historical source changed: '+file);
console.log(JSON.stringify({rounds:files.length,decisions:rows.length,events:events.size,battles:[...events.values()].filter(e=>e.type==='battle').length,sourceFilesUnchanged:true,out}));
