import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {scoreBreakdown} from '../src/shared/scoring.js';
import {functionalValue} from '../src/sim/adaptive-v2-values.js';
import {governanceView} from '../src/shared/governance.js';
import type {GameState} from '../src/shared/types.js';

const root=process.argv[2]??'.data/verification/adaptive-v3';
const percentile=(values:number[],fraction:number)=>{const sorted=[...values].sort((first,second)=>first-second);return sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1))]??0;};
const matrix=JSON.parse(await readFile(join(root,'performance-release','matrix.json'),'utf8'));
const benchmarks=matrix.map((entry:any)=>({snapshot:entry.label,mode:entry.name,hash:entry.samples[0].hash,coldMs:entry.samples[0].wallMs,warmMs:entry.samples.at(-1).wallMs,cpuMs:entry.samples.at(-1).cpuMs,busyCores:entry.samples.at(-1).busyCores,rssMiB:Math.max(...entry.samples.map((sample:any)=>sample.rssMiB)),copiedMiB:entry.samples.at(-1).metrics.copiedBytes/2**20,eventLoopP95Ms:entry.samples.at(-1).lagP95Ms,actors:entry.samples.at(-1).actors}));
const matches=[];
for(const count of [4,8]) {
  const directory=join(root,'match-'+count),summary=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
  const state:GameState=JSON.parse(await readFile(join(directory,'final.json'),'utf8'));
  const actors=state.config.factionIds.map(actor=>{
    const intervals=summary.rows.map((row:any)=>row.actors[actor].intervals);
    const total=(key:string)=>intervals.reduce((sum:number,row:any)=>sum+row[key],0);
    const sensors=functionalValue(state,actor);
    return {actor,name:state.factions[actor].name,strategy:summary.strategies[actor],route:state.factions[actor].civilization?.choice,welfare:state.factions[actor].welfare?.choice,governance:governanceView(state,actor),meanQuality:total('qualitySum')/Math.max(1,total('samples')),score:scoreBreakdown(state,actor),shortageDays:total('shortageDays'),unpaidDays:total('unpaidDays'),lowUnityDays:total('lowUnityDays'),failures:summary.rows.reduce((sum:number,row:any)=>sum+row.actors[actor].failures,0),cancellations:summary.rows.reduce((sum:number,row:any)=>sum+row.actors[actor].cancellations,0),actions:summary.rows.reduce((sum:number,row:any)=>sum+row.actors[actor].actions,0),dutyAwards:state.factions[actor].responsibility?.awardedWars.length??0,objectives:state.warAchievements?.filter(item=>item.actor===actor).length??0,finalDissatisfaction:state.factions[actor].responsibility?.dissatisfaction??0,finalCrisis:state.factions[actor].faith?.crisis??0,activeSensors:sensors.sensors.filter(sensor=>sensor.active).length,totalSensors:sensors.sensors.length,coverage:sensors.covered.length};
  }).sort((first,second)=>second.score.total-first.score.total);
  const wars=Object.fromEntries([...new Set(state.wars?.map(war=>war.type)??[])].map(type=>[type,state.wars?.filter(war=>war.type===type).length??0]));
  matches.push({count,seed:summary.seed,round:state.round,result:state.result,hash:summary.hash,elapsedMs:summary.elapsedMs,planningMedianMs:percentile(summary.rows.map((row:any)=>row.planning.durationMs),.5),planningP95Ms:percentile(summary.rows.map((row:any)=>row.planning.durationMs),.95),peakRssMiB:Math.max(...summary.rows.map((row:any)=>row.planning.peakRssMb)),wars,actors});
}
const aggregate=Object.fromEntries(['v2','standard-serial','standard-parallel','deep-serial','deep-parallel'].map(mode=>{
  const rows=benchmarks.filter((row:any)=>row.mode===mode),values=rows.map((row:any)=>row.warmMs);
  return [mode,{medianMs:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:Math.max(...values),rssMiB:Math.max(...rows.map((row:any)=>row.rssMiB))}];
}));
const result={benchmarks,aggregate,matches,requests:0,tokens:0};
await writeFile(join(root,'report.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({aggregate,matches,reportHash:createHash('sha256').update(JSON.stringify(result)).digest('hex')},null,2));
