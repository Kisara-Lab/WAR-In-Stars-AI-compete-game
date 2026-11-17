import { adaptiveV415Decision } from './adaptive-v415.js';
import { adaptiveV415FinalDecision } from './adaptive-v415final.js';
import { tacticalV415 } from './adaptive-v415-military.js';
import { tacticalV415Final } from './adaptive-v415final-military.js';
import { adaptiveV412Decision } from './adaptive-v412.js';
import { tacticalV412 } from './adaptive-v412-military.js';
import { adaptiveV41Decision } from './adaptive-v41.js';
import { tacticalV41 } from './adaptive-v41-military.js';
import { availableParallelism, freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { performance,monitorEventLoopDelay } from 'node:perf_hooks';
import { ADAPTIVE_V2, ADAPTIVE_V3 } from '../shared/adaptive.js';
import type { Decision, GameState } from '../shared/types.js';
import { scriptKnowledge } from './adaptive-knowledge.js';
import { adaptiveV2Decision } from './adaptive-v2.js';
import { economicForecast } from './forecast.js';
import { adaptiveV3Decision } from './adaptive-v3.js';
import { adaptiveV4Decision } from './adaptive-v4.js';
import { tacticalV4, type TacticalRequestV4 } from './adaptive-v4-military.js';
import type { ForecastScenario } from './forecast-v3.js';
import { PlanningCache } from './planning-cache.js';
import { planningPreview } from './planning-preview.js';
import type { Action } from '../shared/types.js';
import type { ScriptCandidate } from './adaptive-types.js';
import { candidateFacts } from './adaptive-candidates.js';
import { srasDecision } from './sras.js';
import { srasDecision as sras11Decision } from './sras11.js';
import { cerberusDecision } from './sras13-cerberus.js';

export interface PlanningConfig {planningWorkers?:number;forecastWorkers?:number;computeWorkers?:number;planningCacheMiB?:number;v3?:boolean}
export function computeConfig(factions:number,requested:PlanningConfig={}) {
  const maximum=Math.min(ADAPTIVE_V3.threadBudget,Math.max(0,availableParallelism()-2));
  const computeWorkers=requested.computeWorkers??maximum;
  if(!Number.isInteger(computeWorkers)||computeWorkers<0||computeWorkers>maximum)throw new Error('计算线程超出CPU预算；最多64并保留2个逻辑处理器');
  const planningWorkers=Math.min(factions,8,computeWorkers),forecastWorkers=computeWorkers-planningWorkers;
  const planningCacheMiB=requested.planningCacheMiB??Math.floor(Math.min(ADAPTIVE_V3.cacheMiB,freemem()/2**20*.25));
  if(!Number.isInteger(planningCacheMiB)||planningCacheMiB<0||planningCacheMiB>Math.floor(freemem()/2**20*.75))throw new Error('规划缓存预算无效或超过当前可用内存的75%');
  return {planningWorkers,forecastWorkers,computeWorkers,planningCacheMiB,v3:true};
}
export function planningConfig(factions:number,requested:PlanningConfig={}) {
  const budget=Math.min(ADAPTIVE_V2.threadBudget,Math.max(0,availableParallelism()-2));
  const planningWorkers=requested.planningWorkers??Math.min(factions,8,budget);
  const forecastWorkers=requested.forecastWorkers??Math.max(0,budget-planningWorkers);
  if(!Number.isInteger(planningWorkers)||!Number.isInteger(forecastWorkers)||planningWorkers<0||forecastWorkers<0||planningWorkers>Math.min(factions,8)||planningWorkers+forecastWorkers>budget)throw new Error('规划及预测线程超出CPU预算或势力数；总数最多16并保留2核');
  return {planningWorkers,forecastWorkers};
}
interface Job {id:number;payload:Record<string,unknown>;resolve:(result:unknown)=>void;reject:(error:Error)=>void;queued:number}
class TaskPool {
  private workers:{worker:Worker;job?:Job;contexts:Map<string,number>;bytes:number}[]=[];
  private queue:Job[]=[];
  private sequence=0;
  private closed=false;
  private failure?:Error;
  private stateKeys=new WeakMap<object,{key:string;bytes:number}>();
  queueMs=0;
  copiedBytes=0;
  constructor(size:number,private onMessage:(worker:Worker,message:any)=>void,private contextBytes=0) {
    for(let index=0;index<size;index++) {
      const development=import.meta.url.endsWith('.ts');
      const worker=development?new Worker(new URL('./worker-bootstrap.mjs',import.meta.url),{workerData:{entry:new URL('./planning-worker.ts',import.meta.url).href}}):new Worker(new URL('./planning-worker.js',import.meta.url));
      const slot:{worker:Worker;job?:Job;contexts:Map<string,number>;bytes:number}={worker,contexts:new Map(),bytes:0};this.workers.push(slot);
      worker.on('message',message=>{
        this.copiedBytes+=serialize(message).byteLength;
        if(message.kind!=='result'){this.onMessage(worker,message);return;}
        const job=slot.job;if(!job||job.id!==message.id)return;slot.job=undefined;
        if(message.error)job.reject(new Error(message.error));else job.resolve(message.result);this.drain();
      });
      worker.on('error',error=>this.fail(error));worker.on('exit',code=>{if(!this.closed)this.fail(new Error('规划worker退出 '+code));});
    }
  }
  run(payload:Record<string,unknown>):Promise<unknown> {
    if(this.closed)return Promise.reject(this.failure??new Error('规划池已关闭'));
    return new Promise((resolve,reject)=>{this.queue.push({id:++this.sequence,payload,resolve,reject,queued:performance.now()});this.drain();});
  }
  send(worker:Worker,message:Record<string,unknown>){this.copiedBytes+=serialize(message).byteLength;worker.postMessage(message);}
  get retainedBytes(){return this.workers.reduce((sum,slot)=>sum+slot.bytes,0);}
  private drain() {
    for(const slot of this.workers)if(!slot.job&&this.queue.length){
      const job=this.queue.shift()!;slot.job=job;this.queueMs+=performance.now()-job.queued;
      const payload:Record<string,unknown>={...job.payload,id:job.id};
      if(payload.state&&this.contextBytes>0) {
        let record=this.stateKeys.get(payload.state as object);
        if(!record){const encoded=serialize(payload.state);record={key:createHash('sha256').update(encoded).digest('hex'),bytes:encoded.byteLength};this.stateKeys.set(payload.state as object,record);}
        const {key,bytes}=record;
        if(bytes<=this.contextBytes) {
          if(!slot.contexts.has(key)) {
            while(slot.bytes+bytes>this.contextBytes&&slot.contexts.size) {
              const oldest=slot.contexts.keys().next().value!;slot.bytes-=slot.contexts.get(oldest)!;slot.contexts.delete(oldest);
              this.send(slot.worker,{kind:'context-delete',key:oldest});
            }
            this.send(slot.worker,{kind:'context-set',key,state:payload.state});slot.contexts.set(key,bytes);slot.bytes+=bytes;
          }
          this.send(slot.worker,{...payload,state:undefined,contextKey:key});continue;
        }
      }
      this.send(slot.worker,payload);
    }
  }
  clearContexts(){this.stateKeys=new WeakMap();for(const slot of this.workers){slot.contexts.clear();slot.bytes=0;this.send(slot.worker,{kind:'context-clear'});}}
  private fail(error:Error) {this.failure??=error;for(const slot of this.workers){slot.job?.reject(error);slot.job=undefined;}for(const job of this.queue)job.reject(error);this.queue=[];void this.close();}
  async close() {this.closed=true;for(const slot of this.workers){slot.job?.reject(new Error('规划已取消'));slot.job=undefined;}for(const job of this.queue)job.reject(new Error('规划已取消'));this.queue=[];await Promise.all(this.workers.map(slot=>slot.worker.terminate()));}
}

export class PlanningPool {
  readonly config:ReturnType<typeof planningConfig> & PlanningConfig;
  private planning?:TaskPool;
  private forecasts?:TaskPool;
  private audit?:(actor:string,input:unknown)=>Promise<void>;
  private inputs=new Map<string,unknown>();
  private disposed=false;
  private closing?:Promise<void>;
  private active=false;
  private roundToken='';
  private roundSequence=0;
  private cache:PlanningCache<ReturnType<typeof economicForecast>>;
  private inputContexts:PlanningCache<GameState>;
  metrics={planningWorkers:0,forecastWorkers:0,durationMs:0,queueMs:0,peakRssMb:0,cacheHits:0,cacheMisses:0,totalCacheHits:0,totalCacheMisses:0,cacheBytes:0,copiedBytes:0,rounds:0,totalDurationMs:0,processCpuMs:0,eventLoopP95Ms:0};
  constructor(factions:number,config:PlanningConfig={}) {
    this.config=config.v3?computeConfig(factions,config):planningConfig(factions,config);Object.assign(this.metrics,this.config);
    const cacheBytes=Math.floor((this.config.planningCacheMiB??0)*2**20/3);
    this.cache=new PlanningCache(cacheBytes);this.inputContexts=new PlanningCache(cacheBytes);
    if(this.config.forecastWorkers)this.forecasts=new TaskPool(this.config.forecastWorkers,()=>{},Math.floor(cacheBytes/this.config.forecastWorkers));
    if(this.config.planningWorkers)this.planning=new TaskPool(this.config.planningWorkers,(worker,message)=>{
      if(message.roundToken!==undefined&&message.roundToken!==this.roundToken)return;
      if(message.kind==='context-register'){this.inputContexts.set(message.contextKey,message.state);return;}
      if(message.kind.endsWith('-request')&&message.contextKey) {
        if(message.state)this.inputContexts.set(message.contextKey,message.state);
        else message.state=this.inputContexts.get(message.contextKey);
        if(!message.state){this.planning!.send(worker,{kind:'context-miss',requestId:message.requestId});return;}
      }
      if(message.kind==='input')this.inputs.set(message.actor,message.input);
      if(message.kind==='tactical-request')void this.tactical(message.state,message.request).then(result=>{if(!this.disposed)this.planning!.send(worker,{kind:'tactical-response',requestId:message.requestId,result});},error=>{if(!this.disposed)this.planning!.send(worker,{kind:'tactical-response',requestId:message.requestId,error:String(error)});});
      if(message.kind==='forecast-request')void this.forecast(message.state,message.actor,message.horizons,message.scenario).then(result=>{if(!this.disposed)this.planning!.send(worker,{kind:'forecast-response',requestId:message.requestId,result});},error=>{if(!this.disposed)this.planning!.send(worker,{kind:'forecast-response',requestId:message.requestId,error:String(error)});});
      if(message.kind==='preview-request')void this.preview(message.state,message.actor,message.actions,message.candidate).then(result=>{if(!this.disposed)this.planning!.send(worker,{kind:'preview-response',requestId:message.requestId,result});},error=>{if(!this.disposed)this.planning!.send(worker,{kind:'preview-response',requestId:message.requestId,error:String(error)});});
      if(message.kind==='candidates-request')void this.candidates(message.state,message.actor,message.limit).then(result=>{if(!this.disposed)this.planning!.send(worker,{kind:'candidates-response',requestId:message.requestId,result});},error=>{if(!this.disposed)this.planning!.send(worker,{kind:'candidates-response',requestId:message.requestId,error:String(error)});});
    });
  }
  private forecast=async(state:GameState,actor:string,horizons:number[],scenario?:ForecastScenario)=>{
    const bytes=serialize({state,actor,horizons,scenario});
    const key=scenario?createHash('sha256').update(bytes).digest('hex'):'';
    const cached=key?this.cache.get(key):undefined;if(cached)return cached;
    const result=this.forecasts?await this.forecasts.run({kind:'forecast',state,actor,horizons,scenario}) as ReturnType<typeof economicForecast>:economicForecast(state,actor,horizons,scenario);
    if(key)this.cache.set(key,result);return result;
  };
  private preview=async(state:GameState,actor:string,actions:Action[],candidate:ScriptCandidate)=>this.forecasts?await this.forecasts.run({kind:'preview',state,actor,actions,candidate}) as ReturnType<typeof planningPreview>:planningPreview(state,actor,actions,candidate);
  private tactical=async(state:GameState,request:TacticalRequestV4)=>this.forecasts?await this.forecasts.run({kind:'tactical',state,request}) as ReturnType<typeof tacticalV4>:(state.config.scriptStrategy==='adaptive-v4.15-final'?tacticalV415Final:state.config.scriptStrategy==='adaptive-v4.15'?tacticalV415:state.config.scriptStrategy==='adaptive-v4.12'?tacticalV412:state.config.scriptStrategy==='adaptive-v4.1'?tacticalV41:tacticalV4)(state,request);
  private candidates=async(state:GameState,actor:string,limit:number)=>this.forecasts?await this.forecasts.run({kind:'candidates',state,actor,limit}) as ReturnType<typeof candidateFacts>:candidateFacts(state,actor,true,limit,true);
  async decide(state:GameState,signal?:AbortSignal,audit?:(actor:string,input:unknown)=>Promise<void>,strategies?:Record<string,string>,participants?:readonly string[]) {
    if(this.disposed)throw new Error('规划池已关闭');
    if(this.active)throw new Error('同一规划池不能同时处理多个轮边界');
    if(state.rulesRevision!=='5.4')throw new Error('adaptive-v2 仅支持5.4');
    this.active=true;this.roundToken=state.id+':'+state.round+':'+(++this.roundSequence);
    const started=performance.now(),queued=(this.planning?.queueMs??0)+(this.forecasts?.queueMs??0),cacheHits=this.cache.hits,cacheMisses=this.cache.misses,cpu=process.cpuUsage(),lag=monitorEventLoopDelay({resolution:20});lag.enable();this.audit=audit;this.inputs.clear();this.cache.clear();this.metrics.copiedBytes=0;
    const copiedBefore=(this.planning?.copiedBytes??0)+(this.forecasts?.copiedBytes??0);
    const actors=state.config.factionIds.filter(actor=>state.factions[actor].eliminatedDay===undefined&&(!participants||participants.includes(actor)));
    const abort=()=>{void this.close();};signal?.addEventListener('abort',abort,{once:true});
    try {
      const jobs=actors.map(async actor=>{
        if(signal?.aborted)throw new Error('比赛已暂停');
        const known=scriptKnowledge(state,actor),memory=structuredClone(state.factions[actor].scriptMemory);
        if(strategies?.[actor])known.config.scriptStrategy=strategies[actor] as GameState['config']['scriptStrategy'];
        known.factions[actor].scriptMemory=memory;
        const planner=known.config.scriptStrategy==='sras-v1.3cerberus'?cerberusDecision:known.config.scriptStrategy==='sras-v1.1'?sras11Decision:known.config.scriptStrategy==='sras-v1'?srasDecision:known.config.scriptStrategy==='adaptive-v4.15-final'?adaptiveV415FinalDecision:known.config.scriptStrategy==='adaptive-v4.15'?adaptiveV415Decision:known.config.scriptStrategy==='adaptive-v4.12'?adaptiveV412Decision:known.config.scriptStrategy==='adaptive-v4.1'?adaptiveV41Decision:known.config.scriptStrategy==='adaptive-v4'?adaptiveV4Decision:known.config.scriptStrategy==='adaptive-v3'?adaptiveV3Decision:adaptiveV2Decision;
        return this.planning?await this.planning.run({kind:'plan',state:known,actor,memory,roundToken:this.roundToken,useContexts:!!this.config.planningCacheMiB}) as Decision:planner(known,actor,memory,{forecast:this.forecast,preview:this.preview,candidates:this.candidates,tactical:this.tactical,checkpoint:async()=>{await new Promise<void>(resolve=>setImmediate(resolve));if(signal?.aborted)throw new Error('比赛已暂停');},inputAudit:async (input:unknown)=>{this.inputs.set(actor,input);}});
      });
      const decisions=await Promise.all(jobs);
      if(signal?.aborted)throw new Error('比赛已暂停');
      for(const actor of actors)await this.audit?.(actor,this.inputs.get(actor));
      this.metrics.durationMs=performance.now()-started;this.metrics.queueMs=(this.planning?.queueMs??0)+(this.forecasts?.queueMs??0)-queued;this.metrics.peakRssMb=Math.max(this.metrics.peakRssMb,process.memoryUsage().rss/2**20);
      this.metrics.rounds++;this.metrics.totalDurationMs+=this.metrics.durationMs;this.metrics.cacheBytes=this.cache.bytes+this.inputContexts.bytes+(this.forecasts?.retainedBytes??0);this.metrics.cacheHits=this.cache.hits-cacheHits;this.metrics.cacheMisses=this.cache.misses-cacheMisses;this.metrics.totalCacheHits=this.cache.hits;this.metrics.totalCacheMisses=this.cache.misses;
      const usage=process.cpuUsage(cpu);this.metrics.processCpuMs=(usage.user+usage.system)/1000;this.metrics.eventLoopP95Ms=lag.percentile(95)/1e6;
      this.metrics.copiedBytes=(this.planning?.copiedBytes??0)+(this.forecasts?.copiedBytes??0)-copiedBefore;
      return Object.fromEntries(actors.map((actor,index)=>[actor,decisions[index]]));
    } catch(error){await this.close();throw error;}
    finally{this.active=false;lag.disable();signal?.removeEventListener('abort',abort);this.inputs.clear();this.cache.clear();this.inputContexts.clear();if(!this.disposed)this.forecasts?.clearContexts();else await this.close();}
  }
  get closed(){return this.disposed;}
  async close(){this.disposed=true;this.closing??=Promise.all([this.planning?.close(),this.forecasts?.close()]).then(()=>{});await this.closing;}
}
