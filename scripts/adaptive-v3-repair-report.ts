import { readFile,writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { stateHash } from '../src/sim/math.js';
import type { GameState,Decision } from '../src/shared/types.js';
import { ADAPTIVE_V3 } from '../src/shared/adaptive.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { functionalValue } from '../src/sim/adaptive-v2-values.js';

const directory=process.argv[2]??'.data/verification/adaptive-v3-repair/match-4';
if(process.argv[3]) {
  const checkpoint=JSON.parse(await readFile(join(directory,'checkpoint-'+Number(process.argv[3])+'.json'),'utf8'));
  const last=checkpoint.rows.at(-1);
  console.log(JSON.stringify({round:checkpoint.round,actors:Object.fromEntries(Object.keys(last.actors).map(actor=>{
    const rows=checkpoint.rows.filter((row:{turns?:Record<string,{alive:boolean}>})=>row.turns?.[actor]?.alive);
    const total=(field:string)=>rows.reduce((sum:number,row:{actors:Record<string,Record<string,number>>})=>sum+row.actors[actor][field],0);
    return [actor,{strategy:last.actors[actor].strategy,actionsPerRound:total('actions')/Math.max(1,rows.length),empty:rows.filter((row:{actors:Record<string,{actions:number}>})=>!row.actors[actor].actions).length,failures:total('failures'),score:last.actors[actor].score.total,welfare:last.actors[actor].welfare,quality:last.actors[actor].governance.quality,stop:last.turns?.[actor]?.turn?.stop}];
  }))},null,2));process.exit(0);
}
const boundary=JSON.parse(await readFile(join(directory,'latest.json'),'utf8')) as {state:GameState;hash:string;strategies:Record<string,string>};
const actors=Object.fromEntries(boundary.state.config.factionIds.map(actor=>[actor,{strategy:boundary.strategies[actor],decisions:0,actions:0,empty:0,residualActions:0,failures:0,cancellations:0,unpaidDays:0,shortageDays:0,lowUnityDays:0,qualitySum:0,samples:0,idleSum:0,colonySamples:0,stops:{} as Record<string,number>,kinds:{} as Record<string,number>,shipsOrdered:{} as Record<string,number>,maxActions:0,planned:0,acceptedProjects:0,completed:0,maxDissatisfaction:0}]));
const planning:number[]=[],memory:number[]=[],checkpoints:unknown[]=[],segments:Record<string,{actors:Record<string,{decisions:number;actions:number;empty:number;failures:number;residual:number}>;planningMs:number[]}>={};
let requests=0,tokens=0,decisionCount=0;
let expectedRound=1,elapsedMs=0,maximumActions=0;
for await(const line of createInterface({input:createReadStream(join(directory,'rounds.jsonl')),crlfDelay:Infinity})) {
  if(!line.trim())continue;const row=JSON.parse(line);planning.push(row.planning.durationMs);memory.push(row.rssMiB??0);
  if(row.round!==expectedRound++)throw new Error('回合记录缺失或重复');elapsedMs+=row.ms;
  const segment=segments[String(Math.ceil(row.round/20)*20)]??={actors:{},planningMs:[]};segment.planningMs.push(row.planning.durationMs);
  for(const [actor,record] of Object.entries(actors)) {
    const result=row.actors[actor],turn=row.turns?.[actor],eliminated=boundary.state.factions[actor].eliminatedDay;
    if(!result||eliminated!==undefined&&(row.round-1)*100>=eliminated)continue;
    const period=segment.actors[actor]??={decisions:0,actions:0,empty:0,failures:0,residual:0};period.decisions++;period.actions+=result.actions;period.empty+=Number(!result.actions);period.failures+=result.failures;period.residual+=turn?.turn?.stages.residual.actions??0;
    record.decisions++;record.actions+=result.actions;record.empty+=Number(!result.actions);record.failures+=result.failures;record.cancellations+=result.cancellations;record.maxActions=Math.max(record.maxActions,result.actions);
    record.residualActions+=turn?.turn?.stages.residual.actions??0;
    const stop=turn?.turn?.stop??'V2';record.stops[stop]=(record.stops[stop]??0)+1;
    record.maxDissatisfaction=Math.max(record.maxDissatisfaction,result.duty?.dissatisfaction??0);
    if(eliminated!==undefined&&row.round*100>=eliminated)continue;
    for(const key of ['unpaidDays','shortageDays','lowUnityDays','qualitySum','samples'] as const)record[key]+=result.intervals[key];
    for(const planet of result.industry){record.idleSum+=Math.max(0,planet.population-planet.employed);record.colonySamples++;}
  }
  if(row.round%20===0)checkpoints.push({round:row.round,actors:Object.fromEntries(Object.entries(row.actors).map(([actor,result])=>{const current=result as {actions:number;score:{total:number};route:string;welfare:string;governance:unknown;duty:unknown};return [actor,{actions:current.actions,score:current.score.total,route:current.route,welfare:current.welfare,governance:current.governance,duty:current.duty,stop:row.turns?.[actor]?.turn?.stop}];}))});
}
for await(const line of createInterface({input:createReadStream(join(directory,'decisions.jsonl')),crlfDelay:Infinity})) {
  if(!line.trim())continue;const row=JSON.parse(line);
  for(const [actor,raw] of Object.entries(row.decisions)) {
    const decision=raw as Decision;requests+=decision.metrics.requests;tokens+=decision.metrics.totalTokens;decisionCount++;
    maximumActions=Math.max(maximumActions,decision.actions.length);
    if(decision.actions.length>48)throw new Error('动作预算越界');
    if(decision.scriptReport?.version==='adaptive-v3') {
      const limits=ADAPTIVE_V3.profiles[decision.scriptReport.search!.profile];
      if(decision.scriptReport.forecasts>limits.forecasts||decision.scriptReport.search!.evaluations>limits.evaluations||decision.scriptReport.candidates>limits.candidates||decision.scriptReport.validations>3)throw new Error('规划预算越界');
    }
    for(const action of decision.actions) {
    const record=actors[actor];record.kinds[action.type]=(record.kinds[action.type]??0)+1;
    if(['build_structure','build_starbase','colonize_planet','survey_system','consecrate','expand_slots'].includes(action.type))record.planned++;
    if(action.type==='queue_ships')record.planned+=Number(action.args.count);
    }
  }
}
const events:Record<string,number>={};
const seenEvents=new Set<string>();
for await(const line of createInterface({input:createReadStream(join(directory,'events.jsonl')),crlfDelay:Infinity})) {
  if(!line.trim())continue;const row=JSON.parse(line);
  for(const event of row.events as GameState['events']) {
    if(seenEvents.has(event.id))continue;seenEvents.add(event.id);
    events[event.type]=(events[event.type]??0)+1;
    const details=event.details as {factionId?:string;accepted?:boolean;action?:{type:string;args:{shipType?:string;count?:number}};result?:{cancelled?:boolean;projectId?:string;projectIds?:string[]}}|undefined;
    if(event.type==='order'&&details?.accepted&&!details.result?.cancelled&&details.factionId&&actors[details.factionId])actors[details.factionId].acceptedProjects+=(details.result?.projectIds?.length??Number(!!details.result?.projectId));
    if(event.type==='order'&&details?.accepted&&details.action?.type==='queue_ships'&&details.factionId){const record=actors[details.factionId],type=details.action.args.shipType!;record.shipsOrdered[type]=(record.shipsOrdered[type]??0)+(details.action.args.count??0);}
    if(['construction','colony','fleet','exploration','religion'].includes(event.type)&&/完成|建成|下水|投入运行/.test(event.text))for(const actor of event.audience)if(actors[actor])actors[actor].completed++;
  }
}
planning.sort((first,second)=>first-second);
if(requests||tokens||stateHash(boundary.state)!==boundary.hash||expectedRound-1!==boundary.state.round)throw new Error('模型用量、回合完整性或恢复哈希异常');
const final={round:boundary.state.round,hash:stateHash(boundary.state),savedHash:boundary.hash,result:boundary.state.result,planningMedianMs:planning[Math.floor(planning.length/2)],planningP95Ms:planning[Math.min(planning.length-1,Math.floor(planning.length*.95))],peakRssMiB:Math.max(...memory),actors:Object.fromEntries(Object.entries(actors).map(([actor,record])=>[actor,{...record,actionsPerDecision:record.actions/Math.max(1,record.decisions),emptyRate:record.empty/Math.max(1,record.decisions),quality:record.qualitySum/Math.max(1,record.samples),idlePerColony:record.idleSum/Math.max(1,record.colonySamples),eliminatedDay:boundary.state.factions[actor].eliminatedDay,route:boundary.state.factions[actor].civilization?.choice,welfare:boundary.state.factions[actor].welfare?.choice,unity:boundary.state.factions[actor].unity/100,score:scoreBreakdown(boundary.state,actor),sensors:functionalValue(boundary.state,actor).sensors.map(sensor=>({planetId:sensor.planetId,active:sensor.active})),dutyAwards:boundary.state.factions[actor].responsibility?.awardedWars,achievements:boundary.state.warAchievements?.filter(achievement=>achievement.actor===actor)}])),wars:boundary.state.wars?.map(war=>({id:war.id,type:war.type,endedDay:war.endedDay})),events,checkpoints,decisionCount,requests,tokens};
Object.assign(final,{elapsedRoundMs:elapsedMs,maximumActions,roundsVerified:expectedRound-1});
await writeFile(join(directory,'repair-report.json'),JSON.stringify(final,null,2));
await writeFile(join(directory,'repair-periods.json'),JSON.stringify(segments,null,2));
console.log(JSON.stringify({...final,checkpoints:undefined,events:undefined},null,2));
