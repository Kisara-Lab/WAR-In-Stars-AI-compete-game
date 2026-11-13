import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { ADAPTIVE_V2 } from '../shared/adaptive.js';
import type { Decision, GameState } from '../shared/types.js';
import { scriptKnowledge } from './adaptive-knowledge.js';
import { adaptiveV2Decision, type ForecastRequest } from './adaptive-v2.js';
import { economicForecast } from './forecast.js';

export interface PlanningConfig {planningWorkers?:number;forecastWorkers?:number}
export function planningConfig(factions:number,requested:PlanningConfig={}) {
  const budget=Math.min(ADAPTIVE_V2.threadBudget,Math.max(0,availableParallelism()-2));
  const planningWorkers=requested.planningWorkers??Math.min(factions,8,budget);
  const forecastWorkers=requested.forecastWorkers??Math.max(0,budget-planningWorkers);
  if(!Number.isInteger(planningWorkers)||!Number.isInteger(forecastWorkers)||planningWorkers<0||forecastWorkers<0||planningWorkers>Math.min(factions,8)||planningWorkers+forecastWorkers>budget)throw new Error('规划及预测线程超出CPU预算或势力数；总数最多16并保留2核');
  return {planningWorkers,forecastWorkers};
}
interface Job {id:number;payload:Record<string,unknown>;resolve:(result:unknown)=>void;reject:(error:Error)=>void;queued:number}
class TaskPool {
  private workers:{worker:Worker;job?:Job}[]=[];
  private queue:Job[]=[];
  private sequence=0;
  private closed=false;
  queueMs=0;
  constructor(size:number,private onMessage:(worker:Worker,message:any)=>void) {
    for(let index=0;index<size;index++) {
      const development=import.meta.url.endsWith('.ts');
      const worker=development?new Worker(new URL('./worker-bootstrap.mjs',import.meta.url),{workerData:{entry:new URL('./planning-worker.ts',import.meta.url).href}}):new Worker(new URL('./planning-worker.js',import.meta.url));
      const slot:{worker:Worker;job?:Job}={worker};this.workers.push(slot);
      worker.on('message',message=>{
        if(message.kind!=='result'){this.onMessage(worker,message);return;}
        const job=slot.job;if(!job||job.id!==message.id)return;slot.job=undefined;
        if(message.error)job.reject(new Error(message.error));else job.resolve(message.result);this.drain();
      });
      worker.on('error',error=>this.fail(error));worker.on('exit',code=>{if(!this.closed)this.fail(new Error('规划worker退出 '+code));});
    }
  }
  run(payload:Record<string,unknown>):Promise<unknown> {
    if(this.closed)return Promise.reject(new Error('规划池已关闭'));
    return new Promise((resolve,reject)=>{this.queue.push({id:++this.sequence,payload,resolve,reject,queued:performance.now()});this.drain();});
  }
  private drain() {
    for(const slot of this.workers)if(!slot.job&&this.queue.length){const job=this.queue.shift()!;slot.job=job;this.queueMs+=performance.now()-job.queued;slot.worker.postMessage({...job.payload,id:job.id});}
  }
  private fail(error:Error) {for(const slot of this.workers){slot.job?.reject(error);slot.job=undefined;}for(const job of this.queue)job.reject(error);this.queue=[];void this.close();}
  async close() {this.closed=true;for(const slot of this.workers){slot.job?.reject(new Error('规划已取消'));slot.job=undefined;}for(const job of this.queue)job.reject(new Error('规划已取消'));this.queue=[];await Promise.all(this.workers.map(slot=>slot.worker.terminate()));}
}

export class PlanningPool {
  readonly config:ReturnType<typeof planningConfig>;
  private planning?:TaskPool;
  private forecasts?:TaskPool;
  private audit?:(actor:string,input:unknown)=>Promise<void>;
  private inputs=new Map<string,unknown>();
  private disposed=false;
  metrics={planningWorkers:0,forecastWorkers:0,durationMs:0,queueMs:0,peakRssMb:0};
  constructor(factions:number,config:PlanningConfig={}) {
    this.config=planningConfig(factions,config);Object.assign(this.metrics,this.config);
    if(this.config.forecastWorkers)this.forecasts=new TaskPool(this.config.forecastWorkers,()=>{});
    if(this.config.planningWorkers)this.planning=new TaskPool(this.config.planningWorkers,(worker,message)=>{
      if(message.kind==='input')this.inputs.set(message.actor,message.input);
      if(message.kind==='forecast-request')void this.forecast(message.state,message.actor,message.horizons).then(result=>{worker.postMessage({kind:'forecast-response',requestId:message.requestId,result});},error=>{worker.postMessage({kind:'forecast-response',requestId:message.requestId,error:String(error)});});
    });
  }
  private forecast:ForecastRequest=async(state,actor,horizons)=>this.forecasts?await this.forecasts.run({kind:'forecast',state,actor,horizons}) as ReturnType<typeof economicForecast>:economicForecast(state,actor,horizons);
  async decide(state:GameState,signal?:AbortSignal,audit?:(actor:string,input:unknown)=>Promise<void>) {
    if(this.disposed)throw new Error('规划池已关闭');
    if(state.rulesRevision!=='5.4')throw new Error('adaptive-v2 仅支持5.4');
    const started=performance.now();this.audit=audit;this.inputs.clear();
    const actors=state.config.factionIds.filter(actor=>state.factions[actor].eliminatedDay===undefined);
    const abort=()=>{void this.close();};signal?.addEventListener('abort',abort,{once:true});
    try {
      const jobs=actors.map(async actor=>{
        if(signal?.aborted)throw new Error('比赛已暂停');
        const known=scriptKnowledge(state,actor),memory=structuredClone(state.factions[actor].scriptMemory);
        known.factions[actor].scriptMemory=memory;
        return this.planning?await this.planning.run({kind:'plan',state:known,actor,memory}) as Decision:adaptiveV2Decision(known,actor,memory,{forecast:this.forecast,checkpoint:async()=>{await new Promise<void>(resolve=>setImmediate(resolve));if(signal?.aborted)throw new Error('比赛已暂停');},inputAudit:async input=>{this.inputs.set(actor,input);}});
      });
      const decisions=await Promise.all(jobs);
      if(signal?.aborted)throw new Error('比赛已暂停');
      for(const actor of actors)await this.audit?.(actor,this.inputs.get(actor));
      this.metrics.durationMs=performance.now()-started;this.metrics.queueMs=(this.planning?.queueMs??0)+(this.forecasts?.queueMs??0);this.metrics.peakRssMb=Math.max(this.metrics.peakRssMb,process.memoryUsage().rss/2**20);
      return Object.fromEntries(actors.map((actor,index)=>[actor,decisions[index]]));
    } catch(error){await this.close();throw error;}
    finally{signal?.removeEventListener('abort',abort);this.inputs.clear();}
  }
  get closed(){return this.disposed;}
  async close(){this.disposed=true;await Promise.all([this.planning?.close(),this.forecasts?.close()]);}
}
