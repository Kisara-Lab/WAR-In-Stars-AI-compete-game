import { describe, it, expect } from 'vitest';
import { createGame } from '../src/sim/world.js';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { scriptKnowledge } from '../src/sim/adaptive-knowledge.js';
import { developmentV415, developmentPackagesV415, protectsDevelopmentV415 } from '../src/sim/adaptive-v415-development.js';
import { economicForecast } from '../src/sim/forecast.js';
import { adaptiveV415Decision } from '../src/sim/adaptive-v415.js';
import { StagingArea } from '../src/sim/actions.js';
import { planningPreview } from '../src/sim/planning-preview.js';
import { candidateFacts } from '../src/sim/adaptive-candidates.js';
import { stateHash } from '../src/sim/math.js';
import { militaryPlansV415 } from '../src/sim/adaptive-v415-military.js';
import { relationKey } from '../src/shared/diplomacy.js';

const setup=()=>scriptKnowledge(createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted',scriptStrategy:'adaptive-v4.15'},'development-repair'),'umbra');
const forecast=(s:ReturnType<typeof setup>)=>economicForecast(s,'umbra',[100,300,720,1440],{version:'v4.15',actionable:false});

describe('V4.15 colonial capital and opportunity cost',()=>{
  it('counts a friendly base as defense, not an enemy needing more paid ships',()=>{
    const s=setup(),home=s.systems.find(x=>x.ownerId==='umbra')!,fleet=s.fleets.find(f=>f.ownerId==='umbra')!;
    fleet.systemId=home.neighbors[0];
    const enemy={...structuredClone(fleet),id:'known-threat',ownerId:'aurora',systemId:home.id,order:null,ships:[{id:'threat',type:'battleship' as const,hull:50}]};
    s.fleets.push(enemy);s.relations[relationKey('umbra','aurora')].status='war';
    s.factions.umbra.militaryIntel={...s.factions.umbra.militaryIntel,[home.id]:{day:s.day,source:'local',ownerId:'umbra',controllerId:'umbra',base:home.base,fleets:[enemy]}};
    const plans=militaryPlansV415(s,'umbra',candidateFacts(s,'umbra',true,Infinity,true),{version:'adaptive-v4.15',goal:null,tasks:[],failures:[]});
    const defense=plans.find(p=>p.mode==='defend'&&p.target===home.id);
    expect(defense).toBeDefined();expect(defense!.requiredPower).toBeLessThanOrEqual(50);
    expect(defense!.shortPower).toBe(0);
  });
  it('values known colony chains and releases already paid capital',()=>{
    const s=setup(),before=stateHash(s),plan=developmentV415(s,'umbra',forecast(s));
    expect(plan.selected).toBeDefined();expect(plan.selected!.next).toBe('colonize');
    expect(plan.selected!.reserve.minerals).toBe(200);expect(plan.selected!.reserve.food).toBe(100);
    expect(plan.selected!.value).toBeGreaterThan(100);
    const stage=new StagingArea(s,'umbra');expect(stage.execute(plan.selected!.action.type,plan.selected!.action.args).ok).toBe(true);
    const paid=developmentV415(stage.draft,'umbra',forecast(stage.draft),plan.selected);
    const same=paid.alternatives.find(p=>p.id===plan.selected!.id);
    expect(same?.next).toBe('production');expect(same?.cost.minerals).toBeLessThan(200);
    expect(same?.projects.length).toBe(1);expect(stateHash(s)).toBe(before);
  });
  it('protects a saved colony from optional ships while permitting emergency defense',()=>{
    const s=setup();s.factions.umbra.resources.minerals=units(200);
    const before=developmentV415(s,'umbra',forecast(s));
    const candidate=candidateFacts(s,'umbra',true,Infinity,true).candidates.find(c=>c.kind==='ships')!;
    expect(candidate).toBeDefined();
    const stage=new StagingArea(s,'umbra');for(const a of candidate.actions)expect(stage.execute(a.type,a.args).ok).toBe(true);
    const after=developmentV415(stage.draft,'umbra',forecast(stage.draft),before.selected);
    expect(protectsDevelopmentV415(before,after,candidate)).toContain('殖民储资');
    expect(protectsDevelopmentV415(before,after,candidate,true)).toBeNull();
    // A rounded ETA can stay identical after spending. The saved principal must
    // remain protected even then, instead of being nibbled away every round.
    expect(protectsDevelopmentV415(before,before,candidate,false,{before:{energy:100,food:100,minerals:150,alloys:50},after:{energy:100,food:100,minerals:130,alloys:30}})).toContain('已储本金');
  });
  it('does not create hidden colonial returns or reserve impossible endgame investment',()=>{
    const s=setup(),original=developmentV415(s,'umbra',forecast(s));
    const hidden=structuredClone(s);hidden.factions.aurora.resources.minerals=units(100000);
    expect(developmentV415(hidden,'umbra',forecast(hidden))).toEqual(original);
    s.config.maxRounds=2;
    expect(developmentV415(s,'umbra',economicForecast(s,'umbra',[100,200],{version:'v4.15',actionable:false})).selected).toBeUndefined();
  });
  it('allows productive capital to compete and compares a payable farm-colony package',()=>{
    const s=setup(),home=s.systems.find(x=>x.ownerId==='umbra')!;
    home.planets[0].structures=home.planets[0].structures.filter(b=>['farm','solar'].includes(b.type));
    s.factions.umbra.resources.minerals=units(600);
    const projection=forecast(s),plan=developmentV415(s,'umbra',projection);
    const candidates=candidateFacts(s,'umbra',true,Infinity,true).candidates;
    const packages=developmentPackagesV415(s,'umbra',candidates,projection);
    const paired=packages.find(c=>c.actions[0].args.structureType==='farm')!;
    expect(paired).toBeDefined();
    const stage=new StagingArea(s,'umbra');
    for(const a of paired.actions)expect(stage.execute(a.type,a.args).ok).toBe(true);
    const farm=candidates.find(c=>c.kind==='build'&&c.actions[0].args.structureType==='farm')!;
    expect(protectsDevelopmentV415(plan,plan,farm,false,{before:{minerals:200},after:{minerals:100}})).toBeNull();
    expect(stage.actions).toHaveLength(2);
    const preview=planningPreview(s,'umbra',[],paired);
    expect(preview.error).toBeUndefined();
    expect(preview.actions).toHaveLength(2);
    expect(stage.draft.factions.umbra.resources.minerals).toBeLessThan(s.factions.umbra.resources.minerals);
  });
  it('actually submits opening development with consistent certificates and preserved budgets',async()=>{
    const s=setup(),before=stateHash(s),d=await adaptiveV415Decision(s,'umbra',undefined);
    expect(d.actions.some(a=>a.type==='colonize_planet')).toBe(true);
    expect(d.scriptReport!.selected.flatMap(g=>g.actions)).toEqual(d.actions);
    expect(d.scriptReport!.forecasts).toBeLessThanOrEqual(48);
    expect(d.scriptReport!.search!.evaluations).toBeLessThanOrEqual(256);
    expect(d.scriptReport!.v415!.development).toBeDefined();expect(stateHash(s)).toBe(before);
    expect(d.scriptReport!.v415!.certificates.find(c=>!c.groups.length)!.value.conditional).toBe(0);
  },120000);
});
