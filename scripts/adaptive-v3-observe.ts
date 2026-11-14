import { readFile,writeFile,mkdir,appendFile,rename,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance,monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { availableParallelism,totalmem } from 'node:os';
import { PlanningPool } from '../src/sim/planning-pool.js';
import { SimulationPool } from '../src/sim/pool.js';
import { createGame } from '../src/sim/world.js';
import { advanceRound } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { DEFAULT_CONFIG,FACTION_PRESETS } from '../src/shared/rules.js';
import { commitScriptMemory } from '../src/sim/adaptive-adapter.js';
import { scoreBreakdown } from '../src/shared/scoring.js';
import { governanceView } from '../src/shared/governance.js';
import { functionalValue } from '../src/sim/adaptive-v2-values.js';
import { industryPlanet } from '../src/shared/industry.js';
import type { GameState,Decision } from '../src/shared/types.js';
import { ADAPTIVE_V3 } from '../src/shared/adaptive.js';

const sourceDigest=async(directory='src'):Promise<string>=>{
  const entries=await readdir(directory,{withFileTypes:true}),hash=createHash('sha256');
  for(const entry of entries.sort((first,second)=>first.name.localeCompare(second.name,'en'))) {
    const path=join(directory,entry.name);hash.update(entry.name);
    hash.update(entry.isDirectory()?await sourceDigest(path):await readFile(path));
  }
  return hash.digest('hex');
};

const argument=(name:string,fallback:string)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const output=argument('--output','.data/verification/adaptive-v3');
await mkdir(output,{recursive:true});
const mode=argument('--mode','benchmark'),workers=argument('--workers','auto'),profile=argument('--profile','standard') as 'standard'|'deep';
const strategy=argument('--strategy','adaptive-v3') as 'adaptive-v2'|'adaptive-v3';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decisionHash=(decisions:Record<string,Decision>)=>digest(Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,{actions:decision.actions,memory:decision.scriptMemory}])));
const config=strategy==='adaptive-v3'?{v3:true,computeWorkers:workers==='auto'?undefined:Number(workers),planningCacheMiB:Number(argument('--cache','8192'))}:{planningWorkers:workers==='0'?0:undefined,forecastWorkers:workers==='0'?0:undefined};
if(mode==='benchmark') {
  const file=argument('--snapshot','');
  if(!file)throw new Error('--snapshot is required');
  const raw=await readFile(file,'utf8'),saved=JSON.parse(raw),state:GameState=saved.state??saved;
  state.config.scriptStrategy=strategy;
  if(strategy==='adaptive-v3')state.config.scriptSearchProfile=profile;
  const pool=new PlanningPool(state.config.factionIds.length,config);
  const samples:unknown[]=[];
  try {
    for(let repeat=0;repeat<Number(argument('--repeat','3'));repeat++) {
      const cpu=process.cpuUsage(),started=performance.now(),lag=monitorEventLoopDelay({resolution:20});lag.enable();
      const decisions=await pool.decide(state);
      lag.disable();const usage=process.cpuUsage(cpu),wallMs=performance.now()-started;
      const row={repeat,cold:repeat===0,wallMs,cpuMs:(usage.user+usage.system)/1000,busyCores:(usage.user+usage.system)/1000/wallMs,rssMiB:process.memoryUsage().rss/2**20,lagP95Ms:lag.percentile(95)/1e6,hash:decisionHash(decisions),metrics:{...pool.metrics},actors:Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,{actions:decision.actions.length,report:decision.scriptReport,ms:decision.metrics.durationMs}]))};
      samples.push(row);console.log(JSON.stringify({repeat,wallMs,hash:row.hash,metrics:row.metrics}));
      await writeFile(join(output,'benchmark.json'),JSON.stringify({strategy,profile,workers,sourceHash:createHash('sha256').update(raw).digest('hex'),round:state.round,logicalProcessors:availableParallelism(),memoryGiB:totalmem()/2**30,samples},null,2));
    }
  } finally {await pool.close();}
} else if(mode==='match') {
  const resume=process.argv.includes('--resume'),existing=resume?JSON.parse(await readFile(join(output,'latest.json'),'utf8')):null;
  if(!resume&&((await readdir(output)).length))throw new Error('完整观察必须使用新的空目录，拒绝覆盖或混接历史比赛');
  const count=Number(argument('--factions',String(existing?.state?.config?.factionIds?.length??4))),ids=FACTION_PRESETS.slice(0,count).map(faction=>faction.id);
  const seed=count===4?'stars-2026':'adaptive-frontier';
  let state:GameState=existing?.state??createGame({...structuredClone(DEFAULT_CONFIG),seed,factionIds:ids,models:Object.fromEntries(ids.map(actor=>[actor,'scripted'])),systemCount:count*6,maxRounds:120,controller:'scripted',scriptStrategy:'adaptive-v3',scriptSearchProfile:'deep'},'v3-mixed-'+count);
  const resumedStrategies=existing?.strategies as Record<string,'adaptive-v2'|'adaptive-v3'>|undefined;
  const strategies=resumedStrategies??Object.fromEntries(ids.map((actor,index)=>[actor,(index+(count===8?1:0))%2===0?'adaptive-v3':'adaptive-v2'])) as Record<string,'adaptive-v2'|'adaptive-v3'>;
  if(existing&&stateHash(state)!==existing.hash)throw new Error('保存边界哈希不一致');
  const codeHash=await sourceDigest();
  if(resume&&(JSON.parse(await readFile(join(output,'provenance.json'),'utf8'))).codeHash!==codeHash)throw new Error('续跑源码哈希不一致，拒绝混用策略版本');
  const simulation=new SimulationPool(Number(argument('--simulation','8')));
  const planning=new PlanningPool(count,{v3:true,computeWorkers:workers==='auto'?undefined:Number(workers),planningCacheMiB:Number(argument('--cache','8192'))});
  const started=performance.now(),rows:unknown[]=resume?(await readFile(join(output,'rounds.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  if(resume&&(rows.at(-1) as {round:number}|undefined)?.round!==state.round)throw new Error('审计与保存边界不一致');
  if(!resume) {
    await writeFile(join(output,'provenance.json'),JSON.stringify({repair:ADAPTIVE_V3.repair,codeHash,profile:'deep',seed,count,strategies,workers,simulationWorkers:Number(argument('--simulation','8')),maxRounds:120,requests:0,tokens:0,startedAt:new Date().toISOString()},null,2));
    await writeFile(join(output,'initial.json'),JSON.stringify(state));
  } else await appendFile(join(output,'resumes.jsonl'),JSON.stringify({round:state.round,hash:existing.hash,codeHash,at:new Date().toISOString()})+'\n');
  try {
    while(!state.result) {
      const roundStart=performance.now();
      const decisions=await planning.decide(state,undefined,undefined,strategies);
      const events:GameState['events']=[],intervals:Record<string,{shortageDays:number;unpaidDays:number;lowUnityDays:number;qualitySum:number;samples:number}>=Object.fromEntries(ids.map(actor=>[actor,{shortageDays:0,unpaidDays:0,lowUnityDays:0,qualitySum:0,samples:0}]));
      const next=await advanceRound(state,simulation,Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,decision.actions])),async frame=>{
        events.push(...frame.events);
        for(const row of frame.economy as {factionId:string;after:{shortages:Record<string,boolean>;unity:number};welfare?:{fraction:number};governance?:{quality:number}}[]) {
          const record=intervals[row.factionId];record.samples++;
          record.shortageDays+=Object.values(row.after.shortages).some(Boolean)?10:0;
          record.unpaidDays+=(row.welfare?.fraction??1)<1?10:0;record.lowUnityDays+=row.after.unity<6000?10:0;
          record.qualitySum+=(row.governance?.quality??0)/1e6;
        }
      });
      commitScriptMemory(next,decisions);state=next;
      const row={round:state.round,ms:performance.now()-roundStart,planning:{...planning.metrics},actors:Object.fromEntries(ids.map(actor=>[actor,{strategy:strategies[actor],route:state.factions[actor].civilization?.choice,welfare:state.factions[actor].welfare?.choice,governance:governanceView(state,actor),score:scoreBreakdown(state,actor),duty:state.factions[actor].responsibility,intervals:intervals[actor],sensors:functionalValue(state,actor).sensors.map(sensor=>({planetId:sensor.planetId,active:sensor.active,coverage:sensor.coverage.map(item=>item.systemId)})),industry:state.systems.flatMap(system=>system.planets.filter(planet=>planet.ownerId===actor).map(planet=>industryPlanet(planet,state.day))),actions:decisions[actor]?.actions.length??0,forecasts:decisions[actor]?.scriptReport?.forecasts??0,failures:events.filter(event=>event.type==='order'&&event.audience.includes(actor)&&(event.details as {accepted?:boolean})?.accepted===false).length,cancellations:decisions[actor]?.actions.filter(action=>action.type==='cancel_order').length??0}]))};
      Object.assign(row,{rssMiB:process.memoryUsage().rss/2**20,turns:Object.fromEntries(Object.entries(decisions).map(([actor,decision])=>[actor,{turn:decision.scriptReport?.turn,campaign:decision.scriptMemory?.campaign,empty:decision.actions.length===0,alive:state.factions[actor].eliminatedDay===undefined}]))});
      rows.push(row);await appendFile(join(output,'rounds.jsonl'),JSON.stringify(row)+'\n');
      await appendFile(join(output,'events.jsonl'),JSON.stringify({round:state.round,events})+'\n');
      await appendFile(join(output,'decisions.jsonl'),JSON.stringify({round:state.round,decisions})+'\n');
      if(state.round%20===0||state.result){await writeFile(join(output,'round-'+state.round+'.json'),JSON.stringify(state));await writeFile(join(output,'checkpoint-'+state.round+'.json'),JSON.stringify({round:state.round,rows:rows.slice(-20),result:state.result},null,2));if(await sourceDigest()!==codeHash)throw new Error('观察期间源码变化，暂停保存，不混用策略版本');}
      const saveStart=performance.now();await writeFile(join(output,'latest.tmp.json'),JSON.stringify({state,hash:stateHash(state),strategies}));await rename(join(output,'latest.tmp.json'),join(output,'latest.json'));
      await appendFile(join(output,'save-metrics.jsonl'),JSON.stringify({round:state.round,ms:performance.now()-saveStart})+'\n');
      console.log(JSON.stringify({round:state.round,ms:row.ms,planningMs:planning.metrics.durationMs,hash:stateHash(state)}));
    }
    await writeFile(join(output,'final.json'),JSON.stringify(state));
    await writeFile(join(output,'summary.json'),JSON.stringify({seed,count,strategies,round:state.round,result:state.result,hash:stateHash(state),elapsedMs:performance.now()-started,requests:0,tokens:0,rows},null,2));
  } catch(error) {
    await writeFile(join(output,'paused-error.json'),JSON.stringify({round:state.round,error:String(error),codeHash,state,hash:stateHash(state)}));throw error;
  } finally {await planning.close();await simulation.close();}
} else throw new Error('Unknown mode');
