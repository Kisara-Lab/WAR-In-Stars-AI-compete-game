import {readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const directory=resolve(process.argv[2]);
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const manifest=await read(join(directory,'manifest.json'));
const rows=await read(join(directory,'observation/rounds.json'));
const stopped=await read(join(directory,'observation/stopped.json'));
const last=rows.at(-1);
const checked={};
for(const name of ['previous-match-hashes','build-hashes']) {
  const hashes=await read(join(directory,name+'.json'));
  for(const [file,expected] of Object.entries(hashes)) {
    const actual=createHash('sha256').update(await readFile(resolve(file))).digest('hex');
    if(actual!==expected)throw new Error('Preservation failure: '+file);
  }
  checked[name]=Object.keys(hashes).length;
}
let hasNext=false;
try{await access(join(directory,'matches',manifest.id,'round-0061.json'));hasNext=true;}catch{}
const budgets=rows.flatMap(row=>row.factions.filter(f=>f.strategy==='adaptive-v4.12').map(f=>({round:row.round,actor:f.actor,...f.budget})));
const faults=rows.flatMap(row=>row.factions.flatMap(f=>[
  ...(f.metrics.requests||f.metrics.totalTokens?[`${row.round}/${f.actor}: model usage`]:[]),
  ...(f.actions.length>48||f.turn?.actions!==f.actions.length?[`${row.round}/${f.actor}: action accounting`]:[]),

]));
for(const b of budgets)if(b.forecasts>48||b.evaluations>256||b.validations>3)faults.push(`${b.round}/${b.actor}: budget`);
for(const row of rows){
  const saved=await read(join(directory,'matches',manifest.id,`round-${String(row.round).padStart(4,'0')}.json`));
  for(const f of row.factions.filter(f=>f.strategy==='adaptive-v4.12')){
    const report=saved.decisions[f.actor].scriptReport;
    if(report.candidates>256||report.v4?.tacticalEvaluations>12)faults.push(`${row.round}/${f.actor}: candidate/tactical budget`);
  }
}
const ranking=[...last.factions].sort((a,b)=>b.score.total-a.score.total||a.actor.localeCompare(b.actor));
const strictFirst=ranking[0].strategy==='adaptive-v4.12'&&ranking[0].score.total>ranking[1].score.total;
const complete=last.round===60&&stopped.state.round===60&&!stopped.status.running&&!stopped.status.busy&&!stopped.status.error&&!hasNext;
const stats=last.factions.map(f=>{
  const history=rows.map(row=>row.factions.find(x=>x.actor===f.actor));
  const timing=history.map(x=>x.ms).sort((a,b)=>a-b);
  return {actor:f.actor,name:f.name,strategy:f.strategy,score:f.score.total,colonies:f.colonies,ships:f.ships,quality:f.governance.quality,
    actions:history.reduce((n,x)=>n+x.actions.length,0),buildings:history.flatMap(x=>x.actions).filter(a=>a.type==='build_structure').length,
    empty:rows.filter(row=>!row.factions.find(x=>x.actor===f.actor).actions.length).map(r=>r.round),
    shortageBoundaries:history.filter(x=>Object.values(x.shortages).some(Boolean)).length,
    removed:history.reduce((n,x)=>n+(x.removed?.length??0),0),
    stops:Object.fromEntries([...new Set(history.map(x=>x.stop))].map(k=>[k,history.filter(x=>x.stop===k).length])),
    medianMs:timing[Math.floor((timing.length-1)/2)],p95Ms:timing[Math.ceil(timing.length*.95)-1]};
});
const rejectedWorldOrders=rows.flatMap(row=>row.factions.flatMap(f=>f.failures.map(event=>({round:row.round,actor:f.actor,event}))));
const summary={rejectedWorldOrders,revision:manifest.v412Revision,attempt:manifest.attempt,id:manifest.id,round:last.round,complete,strictFirst,passed:complete&&strictFirst&&!faults.length,faults,checked,stats,wars:last.wars,
  checkpoints:rows.filter(r=>r.round%20===0).map(r=>({round:r.round,factions:r.factions.map(f=>({actor:f.actor,score:f.score.total,colonies:f.colonies,ships:f.ships,q:f.governance.quality,actions:f.actions.length}))})),
  finalPlanning:stopped.status.planning};
await writeFile(join(directory,'observation/summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({revision:summary.revision,round:last.round,complete,strictFirst,passed:summary.passed,faults,stats},null,2));
