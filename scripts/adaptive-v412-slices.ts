import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PlanningPool} from '../src/sim/planning-pool.js';
import {SimulationPool} from '../src/sim/pool.js';
import {advanceRound} from '../src/sim/engine.js';
import {commitScriptMemory} from '../src/sim/adaptive-adapter.js';
import {stateHash} from '../src/sim/math.js';
import {governanceView} from '../src/shared/governance.js';
import {scoreBreakdown} from '../src/shared/scoring.js';
import type {Action,GameState} from '../src/shared/types.js';
import {StagingArea} from '../src/sim/actions.js';

const responseMode=process.argv.includes('--responses');
const root='.data/live-adaptive-v41-20261114/matches';
const first='d6b82350-99dc-4fee-a60f-e214477f819c',later='e6e59bae-e296-4f3f-8a89-05cf13164c0f';
const old='.data/live-adaptive-v4-20261114/matches/da00f345-d0f8-4ef8-807b-efff8c53690c';
const load=async(round:number,legacy=false)=>JSON.parse(await readFile(join(legacy?old:join(root,round<=30?first:later),`round-${String(round).padStart(4,'0')}.json`),'utf8'));
const selected=process.argv.includes('--case')?process.argv[process.argv.indexOf('--case')+1]:'';
const cases:( {start:number;actor:string;steps:number;legacy?:boolean;response?:string})[]=(responseMode?[28,45].flatMap(start=>['hold','reinforce','counterattack'].map(response=>({start,actor:'umbra',steps:4,response}))):[{start:17,actor:'cobalt',steps:3},{start:28,actor:'umbra',steps:4},{start:45,actor:'umbra',steps:4},{start:49,actor:'cobalt',steps:10},...Array.from({length:4},(_,i)=>({start:55+i,actor:'umbra',steps:1})),{start:40,actor:'umbra',steps:1,legacy:true}]).filter(c=>!selected||selected===c.start+':'+c.actor);
if(selected&&process.argv.includes('--steps'))for(const test of cases)test.steps=Number(process.argv[process.argv.indexOf('--steps')+1]);
const code=createHash('sha256');for(const path of (await readdir('src/sim')).filter(p=>p.startsWith('adaptive-v412')).sort())code.update(await readFile(join('src/sim',path)));code.update(await readFile('src/shared/adaptive-v412.ts'));
const revision=code.digest('hex'),pool=new PlanningPool(1,{v3:true,computeWorkers:8,planningCacheMiB:1024}),simulation=new SimulationPool(0),results:unknown[]=[];
const out=resolve('.data/verification/adaptive-v412/slices',revision.slice(0,12),responseMode?'fixed-responses':'recorded-orders-v2');await mkdir(out,{recursive:true});
try {for(const test of cases){
    const original=await load(test.start,test.legacy),sourceHash=original.hash,state0:GameState=structuredClone(original.state);state0.config.scriptStrategy='adaptive-v4.12';state0.config.scriptSearchProfile='standard';delete state0.factions[test.actor].scriptMemory;
  let state=state0;const steps=[];
  for(let n=0;n<test.steps;n++){
    const frozen=stateHash(state),start=performance.now(),decisions=await pool.decide(state,undefined,undefined,undefined,[test.actor]),decision=decisions[test.actor];
    const reference=await load(test.start+n+1,test.legacy);
    const recorded=reference.decisions??reference.lastDecisions;
    if(!recorded)throw Error('Historical decisions missing from round '+reference.state.round);
    const orders:Record<string,Action[]>=Object.fromEntries(state.config.factionIds.map(id=>[id,id===test.actor?decision.actions:test.response?[]:recorded[id]?.actions??[]]));
    if(test.response) {
      const war=state.wars?.find(w=>w.endedDay===undefined&&w.goals[test.actor]?.some(g=>!g.invalid));
      const opponent=war?.factions.find(id=>id!==test.actor),target=war?.goals[test.actor]?.find(g=>!g.invalid)?.systemId;
      if(opponent&&target){
        const counter=state.systems.filter(s=>s.ownerId===test.actor).sort((a,b)=>Number(b.id!==state.factions[test.actor].homeSystemId)-Number(a.id!==state.factions[test.actor].homeSystemId)||a.id.localeCompare(b.id))[0]?.id??target;
        const stage=new StagingArea(state,opponent);
        for(const fleet of state.fleets.filter(f=>f.ownerId===opponent&&!f.transit).sort((a,b)=>a.id.localeCompare(b.id))) {
          const destination=test.response==='hold'?fleet.systemId:test.response==='counterattack'&&fleet.systemId!==target?counter:target;
          if(destination)stage.execute('move_fleet',{fleetId:fleet.id,systemId:destination,x:test.response==='hold'?fleet.position.x:500,y:test.response==='hold'?fleet.position.y:500,targetFleetId:null});
        }
        orders[opponent]=stage.actions;
      }
    }
    const next=await advanceRound(state,simulation,orders);commitScriptMemory(next,decisions);
    if(stateHash(state)!==frozen)throw Error('Source boundary mutated');
    const failures=next.events.filter(e=>{const detail=e.details as {factionId?:string;accepted?:boolean}|undefined;return e.round===next.round&&e.type==='order'&&detail?.factionId===test.actor&&detail.accepted===false;});
    const row={round:next.round,ms:performance.now()-start,actions:decision.actions,opponentOrders:Object.fromEntries(Object.entries(orders).filter(([id])=>id!==test.actor)),report:decision.scriptReport,memory:decision.scriptMemory,failures,score:scoreBreakdown(next,test.actor),governance:governanceView(next,test.actor),duty:next.factions[test.actor].responsibility,resources:next.factions[test.actor].resources,events:next.events.filter(e=>e.round===next.round&&e.audience.includes(test.actor)&&['battle','war'].includes(e.type)),hash:stateHash(next),baseline:{actions:recorded[test.actor]?.actions?.length,score:scoreBreakdown(reference.state,test.actor)}};
    steps.push(row);state=next;
    console.log(JSON.stringify({case:test.start+':'+test.actor,round:next.round,actions:decision.actions.length,failures:failures.length,stop:decision.scriptReport?.turn?.stop,forecasts:decision.scriptReport?.forecasts,evaluations:decision.scriptReport?.search?.evaluations,static:decision.scriptReport?.v412?.staticAccepted,ms:row.ms}));
    if(failures.length)throw Error('V4.12 execution rejection in isolated sequence');
  }
  const result={...test,sourceHash,revision,mode:test.response?'fixed-response-counterfactual':'historical-orders-counterfactual',requests:0,steps};results.push(result);
  await writeFile(join(out,`${test.start}-${test.actor}${test.response?'-'+test.response:''}.json`),JSON.stringify(result));
  await writeFile(join(out,'summary'+(responseMode?'-responses':'')+(selected?'-'+selected.replace(':','-'):'')+'.json'),JSON.stringify({revision,results},null,2));
  if((await load(test.start,test.legacy)).hash!==sourceHash)throw Error('Historical checkpoint changed');
}}finally{await pool.close();await simulation.close();}
