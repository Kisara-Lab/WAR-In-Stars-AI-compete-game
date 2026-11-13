import { parentPort } from 'node:worker_threads';
import { adaptiveV2Decision } from './adaptive-v2.js';
import { economicForecast } from './forecast.js';
import type { GameState } from '../shared/types.js';
import type { ScriptMemory } from '../shared/adaptive.js';

const waiting=new Map<number,{resolve:(value:ReturnType<typeof economicForecast>)=>void;reject:(error:Error)=>void}>();
let nextRequest=0;
parentPort!.on('message',async message=>{
  if(message.kind==='forecast-response') {
    const request=waiting.get(message.requestId);if(!request)return;
    waiting.delete(message.requestId);if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  const {id,kind,state,actor,memory,horizons}=message as {id:number;kind:string;state:GameState;actor:string;memory?:ScriptMemory;horizons:number[]};
  try {
    const result=kind==='forecast'?economicForecast(state,actor,horizons):await adaptiveV2Decision(state,actor,memory,{forecast:async(state,actor,horizons)=>new Promise((resolve,reject)=>{
      const requestId=++nextRequest;waiting.set(requestId,{resolve,reject});parentPort!.postMessage({kind:'forecast-request',requestId,state,actor,horizons});
    }),inputAudit:async input=>{parentPort!.postMessage({kind:'input',id,input,actor});}});
    parentPort!.postMessage({kind:'result',id,result});
  } catch(error) {parentPort!.postMessage({kind:'result',id,error:error instanceof Error?error.message:String(error)});}
});
