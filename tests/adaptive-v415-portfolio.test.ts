import {describe,it,expect} from 'vitest';
import {createGame} from '../src/sim/world.js';
import {DEFAULT_CONFIG,units} from '../src/shared/rules.js';
import {economicForecast} from '../src/sim/forecast.js';
import {portfolioV415,continuityV415} from '../src/sim/adaptive-v415-portfolio.js';
import type {DevelopmentV415} from '../src/shared/adaptive-v415.js';
import type {ScriptMemory} from '../src/shared/adaptive.js';
import {welfarePackagesV415} from '../src/sim/adaptive-v415-economy.js';
import {candidateFacts} from '../src/sim/adaptive-candidates.js';

describe('V4.15 shared capital and objective continuity',()=>{
  it('compares staffed supply and welfare as a payable group without inventing jobs',()=>{
    const state=createGame({...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v4.15'},'welfare-package');
    state.day=2000;state.round=20;
    const home=state.systems.find(system=>system.ownerId==='aurora')!;
    for(const planet of home.planets){planet.ownerId='aurora';planet.population=15;planet.structures=[];}
    state.factions.aurora.resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:0};
    state.factions.aurora.welfare!.choice='comfortable';
    const facts=candidateFacts(state,'aurora',true,Infinity,true);
    const packages=welfarePackagesV415(state,'aurora',facts.candidates);
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.every(group=>group.actions.at(-1)!.type==='set_welfare'&&group.actions.slice(0,-1).every(action=>action.type==='build_structure'))).toBe(true);
    for(const planet of home.planets)planet.population=0;
    expect(welfarePackagesV415(state,'aurora',facts.candidates)).toHaveLength(0);
  });
  it('cannot fund two development chains with the same stock or hypothetical income',()=>{
    const state=createGame({...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v4.15'},'portfolio');
    state.factions.aurora.resources={energy:units(10000),food:units(10000),minerals:units(300),alloys:0};
    const forecast=economicForecast(state,'aurora',[100,300,720,1440]);
    for(const row of forecast.horizons)row.resources={energy:10000,food:10000,minerals:300,alloys:0};
    const option=(id:string):DevelopmentV415=>({id,systemId:id,planetId:id,next:'colonize',action:{type:'colonize_planet',args:{planetId:id}},readyDay:0,colonyDay:100,productiveDay:300,reserve:{minerals:200},cost:{minerals:200},projects:[],value:200,optionValue:200,reason:'fixture'});
    const ledger=portfolioV415(state,'aurora',forecast,[option('first'),option('second')]);
    expect(ledger.allocations).toHaveLength(1);
    expect(ledger.reserved.minerals).toBe(200);
    expect(ledger.deferred).toHaveLength(1);
    expect(ledger.conditionalValue).toBe(200);
  });
  it('does not refresh actual progress because unrelated projects or plans change',()=>{
    const state=createGame({...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v4.15'},'continuity');
    const target=state.systems.find(system=>system.ownerId==='aurora')!.planets[0].id;
    const memory:ScriptMemory={version:'adaptive-v4.15',goal:null,tasks:[],failures:[],v415:{feedback:[],reactions:[]}};
    const ledger={day:0,allocations:[{id:'development',target,startDay:0,completeDay:500,cost:{minerals:200},projects:[]}],deferred:[],reserved:{minerals:200},conditionalValue:200};
    memory.v415!.tasks=continuityV415(state,'aurora',memory,ledger);
    state.round=2;state.day=200;
    const changed=continuityV415(state,'aurora',memory,{...ledger,conditionalValue:300});
    expect(changed[0].lastProgressRound).toBe(0);
    expect(changed[0].status).toBe('reassess');
  });
});
