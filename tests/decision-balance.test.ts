import {afterAll,describe,it,expect} from 'vitest';
import {createGame} from '../src/sim/world.js';
import {DEFAULT_CONFIG,FACTION_PRESETS,units} from '../src/shared/rules.js';
import {welfareRules} from '../src/shared/civilization.js';
import {policyComparison} from '../src/shared/comparison.js';
import {stateHash,shortestPath} from '../src/sim/math.js';
import {actionability} from '../src/sim/actionability.js';
import {constructionOptions,resourcePurposes} from '../src/sim/industry.js';
import {pathwayForecasts} from '../src/sim/forecast.js';
import {migrateDecisionBalance,settleWelfare} from '../src/sim/civilization.js';
import {observation,refreshIntel} from '../src/sim/intel.js';
import {decisionComparison} from '../src/sim/options.js';
import {compactDecisionInput} from '../src/server/decision-input.js';
import {StagingArea} from '../src/sim/actions.js';
import {advanceRound,commitActions} from '../src/sim/engine.js';
import {SimulationPool} from '../src/sim/pool.js';

const game=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted'},'decision-fix','5.1');
const pools=[0,2,8].map(n=>new SimulationPool(n));
afterAll(()=>Promise.all(pools.map(p=>p.close())));
describe('5.1决策比较与平衡修复',()=>{
 it('缺粮导致共同支付归零时，不虚报充足电矿也有预算缺口',()=>{
  const s=game(),f=s.factions.aurora;f.resources={energy:units(1000),minerals:units(1000),food:0,alloys:0};
  settleWelfare(s,'aurora',{energy:0,minerals:0,food:0},{energy:0,minerals:0,food:0});
  expect(f.welfare!.last!.fraction).toBe(0);expect(f.welfare!.last!.reasons).toEqual(['food福利预算不足']);expect(f.welfare!.last!.paid).toEqual({energy:0,minerals:0,food:0});
 });
 it('旧福利保持不变；新开局即使凝聚力封顶也需发展粮食产业才能持续最高待遇',()=>{
  const s=game(),f=s.factions.aurora,p=s.systems[0].planets[0];
  expect(s.rulesRevision).toBe('5.1');expect(welfareRules({rulesRevision:'5.0'}).utopian.food).toBe(2);
  f.welfare!.choice='utopian';f.unity=10000;
  expect(policyComparison(s,'aurora',['none'])[0].net.food).toBeLessThan(0);
  p.population=16;p.structures.push({id:'extra-farm',type:'farm'},{id:'extra-solar',type:'solar'},{id:'agriculture',type:'agriculture'});
  const developed=policyComparison(s,'aurora',['none'])[0];
  expect(developed.net.food).toBeGreaterThan(0);expect(developed.net.energy).toBeGreaterThan(0);expect(developed.net.minerals).toBeGreaterThan(0);
 });
 it('4/6/8方多种子均有一跳可探索的对称候选，开局不揭示',()=>{
  for(const n of [4,6,8])for(const seed of ['early-a','early-b','early-c']){
   const s=createGame({...DEFAULT_CONFIG,seed,factionIds:FACTION_PRESETS.slice(0,n).map(f=>f.id),systemCount:n*6},'legacy-map','5.1');
   const homes=Object.values(s.factions).map(f=>f.homeSystemId);
   const holy=s.systems.filter(s=>s.planets.some(p=>p.holyCandidate));
   for(const home of homes) expect(holy.some(h=>shortestPath(s.systems,home,h.id)?.length===1)).toBe(true);
   for(let i=0;i<6;i++)expect(new Set(Array.from({length:n},(_,k)=>s.systems[k*6+i].planets.findIndex(p=>p.holyCandidate))).size).toBe(1);
   expect(holy.every(s=>!homes.includes(s.id)&&s.neighbors.length>=2)).toBe(true);
   expect(observation(s,'aurora',null,false).systems.flatMap(s=>s.planets??[]).some(p=>p.holyCandidate)).toBe(false);
  }
 });
 it('显式迁移保留原档和永久制度，不补资源；新费用与新考核起点独立',()=>{
  const old=createGame(DEFAULT_CONFIG,'old','5.0');old.day=6000;old.round=60;old.factions.aurora.civilization!.choice='utopia';old.factions.aurora.welfare!.choice='utopian';old.factions.aurora.welfare!.highestSince=100;
  const before=stateHash(old),next=migrateDecisionBalance(old);
  expect(stateHash(old)).toBe(before);expect(next.factions.aurora.civilization!.choice).toBe('utopia');expect(next.factions.aurora.resources).toEqual(old.factions.aurora.resources);expect(next.factions.aurora.welfare!.highestSince).toBe(6000);
  expect(next.systems.map(s=>s.position)).toEqual(old.systems.map(s=>s.position));expect(next.rulesRevision).toBe('5.1');
 });
 it('冶炼比较单列合金吞吐与岗位，不以材料价值抵消否定加工，计入在建产能',()=>{
  const s=game();s.systems[0].planets[0].population=16;s.factions.aurora.resources.minerals=units(20000);
  const before=stateHash(s),foundry=constructionOptions(s,'aurora','s0-p0').find(o=>o.type==='foundry')!;
  expect(foundry.alloyThroughputPer100).toBeGreaterThan(0);expect(foundry.paybackDays).toBeNull();
  const stage=new StagingArea(s,'aurora');expect(stage.execute('build_structure',{planetId:'s0-p0',structureType:'foundry'}).ok).toBe(true);
  const purposes=resourcePurposes(stage.draft,'aurora');expect(purposes.processing.afterQueued.alloyOutput).toBeGreaterThan(purposes.processing.alloyOutput);expect(purposes.reserveScoreRemaining).toBe(0);expect(stateHash(s)).toBe(before);
 });
 it('祝圣方案真实扣费300日完成后才获得经济收益；不能预设敌方圣地已被占领',()=>{
  const s=game(),p=s.systems[0].planets[0];p.holyCandidate=true;refreshIntel(s);const before=stateHash(s);
  const paths=pathwayForecasts(s,'aurora'),setup=paths.variants.find(v=>v.choice==='theocracy_consecrated')!;
  expect(setup.allowed).toBe(true);expect((setup.projection as any).completedProjects).toContainEqual({id:'preview-consecrate',kind:'consecrate',day:300});
  const plain=paths.variants.find(v=>v.choice==='theocracy')!;
  expect((setup.projection as any).horizons[0].resources.energy).toBeGreaterThan((plain.projection as any).horizons[0].resources.energy);
  expect(setup.setup).toMatchObject({minerals:200,food:100,days:300});expect(stateHash(s)).toBe(before);
  delete p.holyCandidate;const enemy=s.systems.find(s=>s.ownerId==='umbra')!;enemy.planets[0].holyCandidate=true;s.factions.aurora.surveyed.push(enemy.id);s.factions.aurora.intel[enemy.id]={day:0,system:structuredClone(enemy),fleets:[]};
  const other=pathwayForecasts(s,'aurora').variants.find(v=>v.choice==='theocracy_consecrated');
  if(other) {expect(other.allowed).toBe(false);expect(other.projection).toBeNull();}
 });
 it('已知建基地和合并条件只读；改变未知敌方基地、项目和军力不改变预览',()=>{
  const s=game(),f=s.factions.aurora,target=s.systems.find(s=>s.ownerId===null&&s.neighbors.includes('s0'))!;
  f.surveyed.push(target.id);f.intel[target.id]={day:0,system:structuredClone(target),fleets:[]};
  const before=stateHash(s),facts=actionability(s,'aurora');expect(stateHash(s)).toBe(before);
  expect(facts.systems.find(x=>x.systemId==='s0')!.base.blocker).toContain('不能重复');
  target.ownerId='umbra';target.base={hull:100};target.projects.push({id:'secret',kind:'base',ownerId:'umbra',createdDay:-100,planetId:null,structureType:null,shipType:null,progress:0,requiredDays:200,cost:{energy:0,food:0,minerals:units(200)}});
  s.fleets.find(f=>f.ownerId==='umbra')!.systemId=target.id;
  expect(actionability(s,'aurora')).toEqual(facts);
  const stage=new StagingArea(s,'aurora');expect(stage.execute('build_starbase',{systemId:target.id}).ok).toBe(true);
  const committed=commitActions(s,{aurora:stage.actions});expect(committed.systems.find(x=>x.id===target.id)!.projects).toEqual(target.projects);expect(committed.factions.aurora.resources).toEqual(f.resources);
  expect(committed.events.at(-1)?.text).toContain('目标在共同结算时已不满足基地施工条件');
 });
 it('压缩输入可无损展开，保留所有目标、时间戳、拒绝结果，且比原数据更小',()=>{
  const facts=observation(game(),'aurora'),packed=JSON.parse(JSON.stringify(compactDecisionInput(facts)));
  const expand=(v:any):any=>v&&typeof v==='object'?(v.$ref?expand(packed.definitions[v.$ref.slice(12)]):Array.isArray(v)?v.map(expand):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)]))):v;
  const {encoding,definitions,...data}=packed;
  expect(expand(data)).toEqual(JSON.parse(JSON.stringify(facts)));expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(facts).length);
 });
 it('混合福利、工程与政策在0/2/8 workers及恢复下哈希一致',async()=>{
  const s=game(),stage=new StagingArea(s,'aurora');stage.execute('set_welfare',{welfare:'utopian'});stage.execute('build_structure',{planetId:'s0-p0',structureType:'farm'});
  const first=await Promise.all(pools.map(pool=>advanceRound(s,pool,{aurora:stage.actions})));expect(new Set(first.map(stateHash)).size).toBe(1);
  const a=await advanceRound(first[0],pools[0]),b=await advanceRound(JSON.parse(JSON.stringify(first[0])),pools[1]);expect(stateHash(a)).toBe(stateHash(b));
 });
 it('不同worker分区中同日人口增长事件也保持顺序一致',async()=>{
  const s=game();
  for(const index of [1,6]) {const target=s.systems[index];target.ownerId='aurora';target.controllerId='aurora';target.base={hull:100};target.planets[0].ownerId='aurora';target.planets[0].population=2;target.planets[0].growthDays=499;s.factions.aurora.surveyed.push(target.id);}
  s.factions.aurora.resources={energy:units(10000),food:units(10000),minerals:units(10000),alloys:units(1000)};
  const states=await Promise.all(pools.map(p=>advanceRound(s,p)));expect(new Set(states.map(stateHash)).size).toBe(1);
 });
});
