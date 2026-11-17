import {describe,it,expect} from 'vitest';
import {createGame} from '../src/sim/world.js';
import {DEFAULT_CONFIG} from '../src/shared/rules.js';
import {responsibilityTasks,responsibilityPackages} from '../src/sim/adaptive-v415final-responsibility.js';
import {institutionalOption} from '../src/sim/adaptive-v415final-values.js';
import {candidateFacts} from '../src/sim/adaptive-candidates.js';
import type {ScriptMemory} from '../src/shared/adaptive.js';
import {PlanningPool} from '../src/sim/planning-pool.js';

const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4.15-final',maxRounds:120},'responsibility-fixture');
describe('formal V4.15 responsibility paths',()=>{
  it('keeps decisions and restored memory identical with cache disabled, cold and warm',async()=>{
    const state=fixture();state.config.maxRounds=2;
    const outputs=[];
    for(const planningCacheMiB of [0,64]){
      const pool=new PlanningPool(1,{v3:true,computeWorkers:0,planningCacheMiB});
      try{
        for(let repeat=0;repeat<2;repeat++){
          const decision=(await pool.decide(state,undefined,undefined,undefined,['aurora'])).aurora;
          outputs.push({actions:decision.actions,memory:decision.scriptMemory});
          const restored=JSON.parse(JSON.stringify(state));
          restored.factions.aurora.scriptMemory=JSON.parse(JSON.stringify(decision.scriptMemory));
          const first=(await pool.decide(restored,undefined,undefined,undefined,['aurora'])).aurora;
          const second=(await pool.decide(JSON.parse(JSON.stringify(restored)),undefined,undefined,undefined,['aurora'])).aurora;
          expect(second.actions).toEqual(first.actions);expect(second.scriptMemory).toEqual(first.scriptMemory);
        }
      }finally{await pool.close();}
    }
    for(const output of outputs)expect(output).toEqual(outputs[0]);
  },60000);
  it('keeps the actual clock when unrelated capital changes and reassesses stalled qualification',()=>{
    const state=fixture(),actor='aurora',memory:ScriptMemory={version:'adaptive-v4.15-final',goal:null,tasks:[],failures:[],v415final:{feedback:[],reactions:[]}};
    const initial=responsibilityTasks(state,actor,memory);memory.v415final!.tasks=initial;
    state.round=2;state.day=200;state.factions[actor].resources.alloys=(state.factions[actor].resources.alloys??0)+100000;
    const next=responsibilityTasks(state,actor,memory)[0];
    expect(next.lastProgressRound).toBe(0);expect(next.status).toBe('reassess');expect(next.blockers!.length).toBeGreaterThan(0);
  });
  it('does not book a qualification option without paid welfare or after permanent commitment',()=>{
    const state=fixture(),own=state.factions.aurora;
    expect(institutionalOption(state,'aurora',12000)).toBe(0);
    own.welfare!.choice='utopian';own.welfare!.highestSince=0;
    own.welfare!.history=Array.from({length:72},(_,index)=>({day:(index+1)*10,qualified:true}));
    own.welfare!.last={day:720,population:10,reachablePopulation:10,due:{energy:1,food:1,minerals:1},deliverable:{energy:1,food:1,minerals:1},paid:{energy:1,food:1,minerals:1},fraction:1,reasons:[]};
    own.shortages={energy:false,food:false,minerals:false};state.day=720;
    expect(institutionalOption(state,'aurora',12000)).toBe(50);
    expect(institutionalOption(state,'aurora',1000)).toBe(0);
    own.civilization!.choice='utopia';expect(institutionalOption(state,'aurora',12000)).toBe(0);
  });
  it('offers independently payable prerequisites without pretending the welfare action executed',()=>{
    const state=fixture(),actor='aurora',planet=state.systems.flatMap(system=>system.planets).find(planet=>planet.ownerId===actor)!;
    planet.population=100;
    const facts=candidateFacts(state,actor,true,Infinity,true);
    const choices=responsibilityPackages(state,actor,facts.candidates);
    const prerequisites=choices.filter(choice=>choice.actions.length===1&&choice.actions[0].type==='build_structure');
    expect(prerequisites.length).toBeGreaterThan(0);
    expect(state.factions[actor].welfare!.choice).toBe('comfortable');
  });
});
