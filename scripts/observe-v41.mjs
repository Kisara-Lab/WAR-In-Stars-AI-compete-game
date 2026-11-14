import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {scoreBreakdown} from '../.data/verification/adaptive-v41/runtime/dist/shared/scoring.js';
import {governanceView} from '../.data/verification/adaptive-v41/runtime/dist/shared/governance.js';
import {rates,LABOR} from '../.data/verification/adaptive-v41/runtime/dist/shared/industry.js';

const [id,folder]=process.argv.slice(2);
if(!id||!folder)throw new Error('Usage: node scripts/observe-v41.mjs MATCH_ID OUTPUT_DIRECTORY');
const directory=resolve(folder);await mkdir(directory,{recursive:true});
let rows=[],retries={};
try {rows=JSON.parse(await readFile(join(directory,'rounds.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
try {retries=JSON.parse(await readFile(join(directory,'retries.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
async function api(path,body){const response=await fetch('http://127.0.0.1:8787/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Local API '+response.status);return response.json();}
function summarize(saved){const state=saved.state;return {round:state.round,day:state.day,hash:saved.hash,result:state.result,warCount:state.wars.length,factions:state.config.factionIds.map(actor=>{
  const faction=state.factions[actor],decision=saved.lastDecisions?.[actor],planets=state.systems.flatMap(system=>system.planets).filter(planet=>planet.ownerId===actor);
  return {actor,name:faction.name,controller:state.config.factionControllers[actor],score:scoreBreakdown(state,actor),governance:governanceView(state,actor),systems:state.systems.filter(system=>system.ownerId===actor).length,population:planets.reduce((sum,planet)=>sum+planet.population,0),idle:planets.reduce((sum,planet)=>sum+Math.max(0,planet.population-planet.structures.reduce((jobs,structure)=>jobs+LABOR[structure.type].jobs*(rates(planet,state.day)[structure.id]??0),0)),0),resources:Object.fromEntries(Object.entries(faction.resources).map(([key,value])=>[key,value/1000])),unity:faction.unity/100,shortages:faction.shortages,welfare:faction.welfare.choice,paid:faction.welfare.last?.fraction,route:faction.civilization.choice,faith:faction.faith?.crisis,duty:faction.responsibility,actions:decision?.actions??[],stop:decision?.scriptReport?.turn?.stop,risk:decision?.scriptReport?.v4,operation:faction.scriptMemory?.operation,certificate:decision?.scriptReport?.v41?.finalCertificate,stageGroups:decision?.scriptReport?.v41?.selectedGroups,submittedGroups:decision?.scriptReport?.v41?.submittedGroups,removedGroups:decision?.scriptReport?.v41?.removed,turn:decision?.scriptReport?.turn,windows:decision?.scriptReport?.v41?.windows,stopReasons:decision?.scriptReport?.v41?.stopReasons,budget:{candidates:decision?.scriptReport?.candidates,forecasts:decision?.scriptReport?.forecasts,evaluations:decision?.scriptReport?.search?.evaluations,validations:decision?.scriptReport?.validations},ms:decision?.metrics.durationMs,performance:decision?.scriptReport?.performance,metrics:saved.metrics[actor],ships:state.fleets.filter(fleet=>fleet.ownerId===actor).reduce((sum,fleet)=>sum+fleet.ships.length,0),projects:state.systems.flatMap(system=>system.projects).filter(project=>project.ownerId===actor),structures:planets.flatMap(planet=>planet.structures.map(structure=>({planet:planet.id,type:structure.type,sealed:!!structure.sealed,operation:rates(planet,state.day)[structure.id]??0}))),failures:state.events.filter(event=>event.round===state.round&&event.type==='order'&&event.details?.factionId===actor&&event.details?.accepted===false)};
})};}
for(;;){
  const live=await api('state');if(live.state.id!==id)throw new Error('Observed match changed; refusing to advance another match');
  for(let round=(rows.at(-1)?.round??0)+1;round<=live.state.round;round++){
    const row=summarize(await api(`matches/${id}/rounds/${round}`));rows.push(row);
    await writeFile(join(directory,'rounds.json'),JSON.stringify(rows));
    for(const faction of row.factions)if(faction.controller==='scripted'&&faction.turn?.actions!==faction.actions.length)throw new Error('Submitted action/report mismatch: '+faction.actor);
    await writeFile(join(directory,'runtime.json'),JSON.stringify({round:live.state.round,phase:live.status.phase,planning:live.status.planning,workers:live.status.workers}));
    console.log(JSON.stringify({round,warCount:row.warCount,factions:row.factions.map(faction=>({id:faction.actor,actions:faction.actions.length,score:faction.score.total,systems:faction.systems,q:faction.governance.quality,paid:faction.paid,short:faction.shortages,ships:faction.ships,ms:faction.ms,stop:faction.stop}))}));
    if(round%20===0||row.result)await writeFile(join(directory,`checkpoint-${round}.json`),JSON.stringify({id,through:round,rows:rows.slice(-20)},null,2));
  }
  if(live.state.result&&!live.status.busy){await api('save',{});await writeFile(join(directory,'final.json'),JSON.stringify(live,null,2));console.log(JSON.stringify({finished:true,id,result:live.state.result}));break;}
  if(!live.status.running&&!live.status.busy){
    if(live.status.error&&/timeout|timed out|超时|超过\d+秒|TimeoutError/i.test(live.status.error)&&!retries[live.state.round]){
      retries[live.state.round]={time:new Date().toISOString(),error:live.status.error};await writeFile(join(directory,'retries.json'),JSON.stringify(retries,null,2));
      console.log(JSON.stringify({retryRound:live.state.round+1,reason:live.status.error,maximum:1}));await api('start',{});
    }else{await api('save',{});await writeFile(join(directory,'stopped.json'),JSON.stringify(live,null,2));console.log(JSON.stringify({stopped:true,round:live.state.round,error:live.status.error,phase:live.status.phase}));break;}
  }
  await setTimeout(5000);
}
