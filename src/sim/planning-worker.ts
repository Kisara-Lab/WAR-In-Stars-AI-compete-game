import { adaptiveV412Decision } from './adaptive-v412.js';
import { tacticalV412 } from './adaptive-v412-military.js';
import { adaptiveV41Decision } from './adaptive-v41.js';
import { tacticalV41 } from './adaptive-v41-military.js';
import { parentPort,threadId } from 'node:worker_threads';
import { adaptiveV2Decision } from './adaptive-v2.js';
import { adaptiveV3Decision } from './adaptive-v3.js';
import { adaptiveV4Decision } from './adaptive-v4.js';
import { tacticalV4, type TacticalRequestV4 } from './adaptive-v4-military.js';
import type { ForecastScenario } from './forecast-v3.js';
import { planningPreview } from './planning-preview.js';
import { candidateFacts } from './adaptive-candidates.js';
import { srasDecision } from './sras.js';
import { srasDecision as sras11Decision } from './sras11.js';
import { economicForecast } from './forecast.js';
import type { GameState } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';

const waiting=new Map<number,{resolve:(value:ReturnType<typeof economicForecast>)=>void;reject:(error:Error)=>void}>();
const tactics=new Map<number,{resolve:(value:ReturnType<typeof tacticalV4>)=>void;reject:(error:Error)=>void}>();
const previews=new Map<number,{resolve:(value:ReturnType<typeof planningPreview>)=>void;reject:(error:Error)=>void}>();
const candidateRequests=new Map<number,{resolve:(value:ReturnType<typeof candidateFacts>)=>void;reject:(error:Error)=>void}>();
let nextRequest=0;
const contexts=new Map<string,GameState>();
const contextIds=new WeakMap<object,string>();
const retries=new Map<number,Record<string,unknown>>();
let useContexts=false;
let roundToken='';
function sendRequest(requestId:number,kind:string,payload:Record<string,unknown>) {
  const full={kind,requestId,roundToken,...payload};retries.set(requestId,full);
  if(useContexts&&payload.state) {
    let contextKey=contextIds.get(payload.state as object);
    if(!contextKey){contextKey=threadId+':'+requestId;contextIds.set(payload.state as object,contextKey);parentPort!.postMessage({kind:'context-register',contextKey,state:payload.state,roundToken});}
    parentPort!.postMessage({...full,state:undefined,contextKey});
  } else parentPort!.postMessage(full);
}
parentPort!.on('message',async message=>{
  if(message.kind==='context-miss'){const original=retries.get(message.requestId);if(original)parentPort!.postMessage(original);return;}
  if(message.kind.endsWith('-response'))retries.delete(message.requestId);
  if(message.kind==='context-set'){contexts.set(message.key,message.state);return;}
  if(message.kind==='context-delete'){contexts.delete(message.key);return;}
  if(message.kind==='context-clear'){contexts.clear();return;}
  if(message.contextKey){message.state=contexts.get(message.contextKey);if(!message.state){parentPort!.postMessage({kind:'result',id:message.id,error:'规划上下文已失效，整轮暂停'});return;}}
  if(message.kind==='forecast-response') {
    const request=waiting.get(message.requestId);if(!request)return;
    waiting.delete(message.requestId);if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  if(message.kind==='tactical-response') {
    const request=tactics.get(message.requestId);if(!request)return;
    tactics.delete(message.requestId);if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  if(message.kind==='preview-response') {
    const request=previews.get(message.requestId);if(!request)return;
    previews.delete(message.requestId);if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  if(message.kind==='candidates-response') {
    const request=candidateRequests.get(message.requestId);if(!request)return;
    candidateRequests.delete(message.requestId);if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  const {id,kind,state,actor,memory,horizons}=message as {id:number;kind:string;state:GameState;actor:string;memory?:ScriptMemory;horizons:number[]};
  if(kind==='plan'){useContexts=!!message.useContexts;roundToken=message.roundToken??'';}
  try {
    const planner=state.config.scriptStrategy==='sras-v1.1'?sras11Decision:state.config.scriptStrategy==='sras-v1'?srasDecision:state.config.scriptStrategy==='adaptive-v4.12'?adaptiveV412Decision:state.config.scriptStrategy==='adaptive-v4.1'?adaptiveV41Decision:state.config.scriptStrategy==='adaptive-v4'?adaptiveV4Decision:state.config.scriptStrategy==='adaptive-v3'?adaptiveV3Decision:adaptiveV2Decision;
    const result=kind==='tactical'?(state.config.scriptStrategy==='adaptive-v4.12'?tacticalV412:state.config.scriptStrategy==='adaptive-v4.1'?tacticalV41:tacticalV4)(state,message.request):kind==='candidates'?candidateFacts(state,actor,true,message.limit,true):kind==='preview'?planningPreview(state,actor,message.actions,message.candidate):kind==='forecast'?economicForecast(state,actor,horizons,message.scenario):await planner(state,actor,memory,{tactical:async(state:GameState,request:TacticalRequestV4)=>new Promise<ReturnType<typeof tacticalV4>>((resolve,reject)=>{
      const requestId=++nextRequest;tactics.set(requestId,{resolve,reject});sendRequest(requestId,'tactical-request',{state,request});
    }),forecast:async(state:GameState,actor:string,horizons:number[],scenario?:ForecastScenario)=>new Promise((resolve,reject)=>{
      const requestId=++nextRequest;waiting.set(requestId,{resolve,reject});sendRequest(requestId,'forecast-request',{state,actor,horizons,scenario});
    }),preview:async(state:GameState,actor:string,actions:import('../shared/types.js').Action[],candidate:import('./adaptive-types.js').ScriptCandidate)=>new Promise<ReturnType<typeof planningPreview>>((resolve,reject)=>{
      const requestId=++nextRequest;previews.set(requestId,{resolve,reject});sendRequest(requestId,'preview-request',{state,actor,actions,candidate});
    }),candidates:async(state:GameState,actor:string,limit:number)=>new Promise<ReturnType<typeof candidateFacts>>((resolve,reject)=>{
      const requestId=++nextRequest;candidateRequests.set(requestId,{resolve,reject});sendRequest(requestId,'candidates-request',{state,actor,limit});
    }),inputAudit:async (input:unknown)=>{parentPort!.postMessage({kind:'input',id,input,actor,roundToken});}});
    parentPort!.postMessage({kind:'result',id,result});
  } catch(error) {parentPort!.postMessage({kind:'result',id,error:error instanceof Error?error.message:String(error)});}
});
