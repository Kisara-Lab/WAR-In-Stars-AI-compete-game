import { afterAll, describe, expect, it } from 'vitest';
import { CIVILIZATION, WELFARE, civilizationEligibility, welfareQuote, civilizationView } from '../src/shared/civilization.js';
import { cohesionBreakdown, currentPolicy } from '../src/shared/civil.js';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { relationKey } from '../src/shared/diplomacy.js';
import { createGame } from '../src/sim/world.js';
import { applyCivilization, migrateCivilization, settleWelfare, trackCivilization } from '../src/sim/civilization.js';
import { StagingArea, toolDefinitions } from '../src/sim/actions.js';
import { advanceRound, economyFactors } from '../src/sim/engine.js';
import { SimulationPool } from '../src/sim/pool.js';
import { stateHash } from '../src/sim/math.js';
import { decisionComparison } from '../src/sim/options.js';
import { observation, refreshIntel } from '../src/sim/intel.js';
import { createWar } from '../src/sim/wars.js';
import { constructionOptions, industryComparison } from '../src/sim/industry.js';
import { decisionRules } from '../src/server/decision-rules.js';
import { economicForecast } from '../src/sim/forecast.js';
import {policyComparison} from '../src/shared/comparison.js';
import { processLocal } from '../src/sim/local.js';
import { ModelProvider } from '../src/server/provider.js';
import { batchCall, response } from './helpers/responses.js';
import { commitActions } from '../src/sim/engine.js';

const pools=[0,2,8].map(n=>new SimulationPool(n));
afterAll(async()=>{await Promise.all(pools.map(p=>p.close()));});
const fixture=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted'},'v5-fixture','5.0');
const zero=()=>({energy:0,food:0,minerals:0});
const rich=(s:ReturnType<typeof fixture>)=> {for(const f of Object.values(s.factions)) f.resources={energy:units(100000),minerals:units(100000),food:units(100000),alloys:units(1000)};return s;};
function qualify(s:ReturnType<typeof fixture>, failures=0) {
  const f=s.factions.aurora;
  applyCivilization(s,'aurora',{type:'set_welfare',args:{welfare:'utopian'}});
  for(let tick=1;tick<=72;tick++) {s.day=tick*10;settleWelfare(s,'aurora',zero(),zero());trackCivilization(s,{aurora:tick<=failures?7900:8000,umbra:8000,verdant:8000,cobalt:8000});}
  f.unity=8000;
}
describe('V5福利与永久制度',()=>{
  it('静态福利比较先扣真实驻留维护折扣，再计算三资源兑现比例',()=>{
    const s=rich(fixture()),f=s.factions.aurora,p=s.systems.find(x=>x.ownerId==='aurora')!.planets.find(p=>p.ownerId==='aurora')!;
    p.population=16;p.structures=p.structures.filter(b=>b.type!=='solar');
    p.structures.push({id:'maintenance-preview',type:'maintenance'});
    f.welfare!.choice='utopian';
    const full=policyComparison(s,'aurora',['none'])[0];
    const baseline=full.upkeep.energy-full.welfarePaid.energy;
    f.resources.energy=units((baseline-full.production.energy+full.welfarePaid.energy/2)/10);
    const hash=stateHash(s),partial=policyComparison(s,'aurora',['none'])[0];
    expect(partial.welfarePaid.energy/full.welfarePaid.energy).toBeCloseTo(.5,3);
    expect(stateHash(s)).toBe(hash);
  });
  it('建设比较前后采用相同的全国在建产能，且不修改查询世界',()=>{
    const s=rich(fixture()),home=s.systems.find(x=>x.ownerId==='aurora')!;
    const p=home.planets.find(p=>p.ownerId==='aurora')!;
    const other=structuredClone(p);other.id='preview-other';other.population=16;other.structures=[];
    home.planets.push(other);
    const stage=new StagingArea(s,'aurora');
    expect(stage.execute('build_structure',{planetId:other.id,structureType:'farm'}).ok).toBe(true);
    const queued=stage.draft,hash=stateHash(queued);
    const a=constructionOptions(queued,'aurora',p.id);
    const complete=structuredClone(queued),system=complete.systems.find(x=>x.id===home.id)!;
    const project=system.projects.find(q=>q.planetId===other.id)!;
    system.planets.find(x=>x.id===other.id)!.structures.push({id:project.id,type:project.structureType!});
    system.projects=system.projects.filter(q=>q.id!==project.id);
    const b=constructionOptions(complete,'aurora',p.id);
    expect(a).toEqual(b);expect(stateHash(queued)).toBe(hash);
  });
  it('新局V5、六档账单/十日支付/显示单位一致，人口不重复乘凝聚力',()=>{
    const s=rich(fixture());expect(s.version).toBe(5);expect(s.rulesRevision).toBe('5.0');
    for(const [id,r] of Object.entries(WELFARE)){
      s.factions.aurora.welfare!.choice=id as keyof typeof WELFARE;
      const q=welfareQuote(s,'aurora',10),up=zero();settleWelfare(s,'aurora',zero(),up);
      expect(up).toEqual(q.due);expect(q.due.energy).toBe(units(r.energy));
      expect(s.factions.aurora.welfare!.last!.fraction).toBe(1);
      expect(cohesionBreakdown(s,'aurora').welfare).toBe(r.unity);
      expect(civilizationView(s,'aurora').billPer100.due.energy).toBe(r.energy*10);
    }
  });
  it('基础维护优先、三资源同比缩减；占领不支付但计失约',()=>{
    const s=fixture(),f=s.factions.aurora;f.welfare!.choice='utopian';f.resources={energy:4000,minerals:100000,food:100000};
    const up={energy:2500,minerals:0,food:0};expect(settleWelfare(s,'aurora',zero(),up).energy).toBe(false);
    expect(f.welfare!.last!.paid).toEqual({energy:1500,minerals:1000,food:1000});expect(f.welfare!.last!.fraction).toBe(.5);
    expect(cohesionBreakdown(s,'aurora').welfare).toBe(-1);
    s.systems[0].controllerId='umbra';const occupiedUp=zero();settleWelfare(s,'aurora',zero(),occupiedUp);
    expect(occupiedUp).toEqual(zero());expect(f.welfare!.last!.fraction).toBe(0);expect(f.welfare!.last!.reasons).toContain('占领区无法交付');
  });
  it('待遇首次选择、360日冷却与三条永久路线互斥',()=>{
    const s=fixture(),stage=new StagingArea(s,'aurora');
    expect(stage.execute('set_welfare',{welfare:'welfare'}).ok).toBe(true);
    expect(stage.execute('set_welfare',{welfare:'basic'}).ok).toBe(false);
    stage.draft.day=360;expect(stage.execute('set_welfare',{welfare:'utopian'}).ok).toBe(true);
    expect(stage.draft.factions.aurora.civilization!.choice).toBe('secular');
    expect(stage.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true}).ok).toBe(true);
    expect(stage.execute('establish_civilization',{civilization:'utopia',acknowledgePermanent:true}).ok).toBe(false);
    expect(stage.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true}).ok).toBe(false);
  });
  it('720日/90%门槛，重工业不禁建国；征服必须明确撤回',()=>{
    const s=rich(fixture());qualify(s,7);expect(civilizationEligibility(s,'aurora','utopia').allowed).toBe(true);
    const broken=rich(fixture());qualify(broken,8);expect(civilizationEligibility(broken,'aurora','utopia').allowed).toBe(false);
    s.conquests=[{id:'test',actor:'aurora',target:'umbra',startedDay:0,readyDay:360,freePeaceDays:0,reason:'合成测试'} as NonNullable<typeof s.conquests>[number]];
    expect(civilizationEligibility(s,'aurora','utopia').allowed).toBe(false);
    s.conquests=[];applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'utopia',acknowledgePermanent:true}});
    const stage=new StagingArea(s,'aurora');expect(stage.execute('set_welfare',{welfare:'basic'}).ok).toBe(false);
    expect(stage.execute('prepare_conquest',{factionId:'umbra',reason:'测试'}).ok).toBe(false);
  });
  it('乌托邦主动总体战不失格，失约暂停正向奖励，恢复后重启',()=>{
    const s=rich(fixture());qualify(s);applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'utopia',acknowledgePermanent:true}});
    const f=s.factions.aurora;f.beacon!.streak=3;
    expect(policyComparison(s,'aurora',['exercises'])[0].cohesion.beacon).toBe(2);
    const w=createWar(s,['aurora','umbra'],'total');w.attackers=['aurora'];
    expect(cohesionBreakdown(s,'aurora').civilization).toBe(2);expect(cohesionBreakdown(s,'aurora').beacon).toBe(2);
    f.welfare!.last!.fraction=.5;expect(cohesionBreakdown(s,'aurora').civilization).toBe(0);expect(cohesionBreakdown(s,'aurora').beacon).toBe(0);
    f.welfare!.last!.fraction=1;expect(cohesionBreakdown(s,'aurora').civilization).toBe(2);
    for(let i=0;i<72;i++){s.day+=10;trackCivilization(s,{aurora:8000,umbra:8000,verdant:8000,cobalt:8000});}
    expect(s.civilizationAwards?.filter(a=>a.actor==='aurora'&&a.category==='utopia')).toHaveLength(1);
  });
  it('军国准备优惠，战力/舰船维护/造舰与工业惩罚分别生效',()=>{
    const s=rich(fixture());applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}});
    s.factions.aurora.policy={choice:'exercises',term:0,locked:true,explicit:true};
    const war=createWar(s,['aurora','umbra'],'total');war.attackers=['aurora'];
    const factors=economyFactors(s).aurora;expect(factors.civilizationCombat).toBe(1.1);expect(factors.exerciseCombat).toBe(1.03);expect(factors.shipSpeed).toBe(1.15);expect(factors.warUpkeep).toBeCloseTo(1.25*1.1*1.05);
    expect(currentPolicy(s,'aurora').penalty).toBe(1.25);expect(currentPolicy(s,'aurora').minerals).toBe(1);
    const other=rich(fixture());applyCivilization(other,'aurora',{type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}});
    const target=other.systems.find(x=>x.ownerId==='umbra')!;other.systems[0].neighbors.push(target.id);target.neighbors.push(other.systems[0].id);other.relations[relationKey('aurora','umbra')].status='peace';other.factions.aurora.intel[target.id]={day:0,system:structuredClone(target),fleets:[]};
    const stage=new StagingArea(other,'aurora');expect(stage.execute('prepare_conquest',{factionId:'umbra',reason:'合成测试'}).ok).toBe(true);
    expect(stage.draft.conquests![0].readyDay).toBe(180);
    const mixed=rich(fixture());const border=mixed.systems.find(x=>x.ownerId==='umbra')!;border.neighbors.push('s0');mixed.relations[relationKey('aurora','umbra')].status='peace';mixed.factions.aurora.intel[border.id]={day:0,system:structuredClone(border),fleets:[]};
    const plan=new StagingArea(mixed,'aurora');expect(plan.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true}).ok).toBe(true);expect(plan.execute('prepare_conquest',{factionId:'umbra',reason:'同轮军国优惠'}).ok).toBe(true);
    const committed=commitActions(mixed,{aurora:plan.actions});expect(committed.conquests![0].readyDay).toBe(180);expect(committed.factions.aurora.resources).toEqual(plan.draft.factions.aurora.resources);expect(other.factions.aurora.resources.minerals-stage.draft.factions.aurora.resources.minerals).toBe(units(150));
  });
  it('国教锁教廷保障且失约进入危机，未祝圣无额外失守处罚',()=>{
    const s=rich(fixture()),p=s.systems[0].planets[0];p.holyCandidate=true;
    const stage=new StagingArea(s,'aurora');expect(stage.execute('establish_religion',{planetId:p.id,name:'测试国教',doctrine:'测试场景',acknowledgePermanent:true}).ok).toBe(true);
    const f=stage.draft.factions.aurora;expect(f.civilization?.choice).toBe('theocracy');expect(f.welfare?.choice).toBe('church');
    expect(stage.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true}).ok).toBe(false);
    f.resources=zero();settleWelfare(stage.draft,'aurora',zero(),zero());expect(f.faith!.pending).toContainEqual(expect.objectContaining({reason:'教廷保障失约',amount:.2}));
    expect(f.faith!.sites[0].consecratedDay).toBeUndefined();
  });
  it('V5政策schema与旧修订分离',()=>{
    const s=fixture(),old=createGame(DEFAULT_CONFIG,'old','4.3');
    expect(new StagingArea(s,'aurora').execute('choose_policy',{policy:'utopia'}).ok).toBe(false);
    expect(new StagingArea(s,'aurora').execute('choose_policy',{policy:'listening'}).ok).toBe(true);
    expect(new StagingArea(old,'aurora').execute('choose_policy',{policy:'exercises'}).ok).toBe(false);
    expect(JSON.stringify(toolDefinitions(true,s))).toContain('set_welfare');expect(JSON.stringify(toolDefinitions(true,old))).not.toContain('set_welfare');
    expect(decisionRules(s)).toContain('参战不使评估失格');expect(decisionRules(s)).not.toContain('主动总体战使');
  });
  it('旧分支迁移不改原哈希，不把旧乌托邦自动变永久路线，不补分',()=>{
    const old=createGame(DEFAULT_CONFIG,'old','4.3');old.day=6000;old.round=60;old.factions.aurora.policy={choice:'utopia',term:8,locked:true,explicit:true,next:{choice:'utopia',term:9}};const before=stateHash(old);
    const next=migrateCivilization(old);expect(stateHash(old)).toBe(before);expect(next.version).toBe(5);expect(next.factions.aurora.civilization?.choice).toBe('secular');expect(next.factions.aurora.welfare?.firstChoice).toBe(true);expect(next.factions.aurora.policy?.choice).toBe('none');expect(next.factions.aurora.policy?.next).toBeUndefined();expect(next.factions.aurora.resources).toEqual(old.factions.aurora.resources);expect(next.factions.aurora.welfare?.history).toHaveLength(0);
  });
  it('所有比较只读且不读取敌方隐藏经济与舰队；在建岗位进入比较',()=>{
    const s=rich(fixture()),stage=new StagingArea(s,'aurora');expect(stage.execute('build_structure',{planetId:'s0-p0',structureType:'foundry'}).ok).toBe(true);const world=stage.draft;const before=stateHash(world);
    const first=decisionComparison(world,'aurora');expect(stateHash(world)).toBe(before);expect(first.industry?.[0].reservedJobs).toBe(2);
    expect(first.pathwayForecasts?.variants.some(v=>v.choice==='theocracy')).toBe(true);
    world.factions.umbra.resources.minerals=1;world.fleets.find(f=>f.ownerId==='umbra')!.ships=[];
    expect(decisionComparison(world,'aurora')).toEqual(first);
    expect(observation(world,'aurora').comparison?.institutions?.route?.choice).toBe('secular');
  });
  it('福利加工、政策换届、军国与国教混合0/2/8 workers及恢复哈希一致',async()=>{
    const s=rich(fixture());applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}});
    s.day=700;s.round=7;s.factions.aurora.policy={term:0,choice:'exercises',locked:true,explicit:true,next:{term:1,choice:'exchange'}};
    const results=await Promise.all(pools.map(p=>advanceRound(s,p)));
    expect(new Set(results.map(stateHash)).size).toBe(1);expect(results[0].factions.aurora.policy!.choice).toBe('exchange');
    const direct=await advanceRound(results[0],pools[0]),restored=await advanceRound(JSON.parse(JSON.stringify(results[0])),pools[1]);expect(stateHash(direct)).toBe(stateHash(restored));
    expect(Object.values(direct.factions).every(f=>Object.values(f.resources).every(v=>v>=0))).toBe(true);
  });
  it('演习只加舰队、军国同时加基地；完整战力修正用于战损换算',()=>{
    const s=fixture();s.factions.aurora.civilization={choice:'militarist',establishedDay:0};s.factions.aurora.policy={choice:'exercises',term:0,locked:true,explicit:true};
    const sys=s.systems[0], own=s.fleets.find(f=>f.ownerId==='aurora')!,enemy=s.fleets.find(f=>f.ownerId==='umbra')!;
    own.systemId=sys.id;own.position={x:500,y:500};enemy.systemId=sys.id;enemy.position={x:500,y:500};enemy.ships=[{id:'test-enemy',type:'cruiser',hull:30}];
    createWar(s,['aurora','umbra'],'total');
    const out=processLocal({phase:'combat',day:10,seed:s.config.seed,systems:[structuredClone(sys)],fleets:[structuredClone(own),structuredClone(enemy)],factions:economyFactors(s),relations:s.relations,wars:s.wars});
    const battle=out.events.find(e=>e.type==='battle')!.details as {effectivePower:Record<string,number>};
    expect(battle.effectivePower.aurora).toBeCloseTo((30*1.03+40)*1.1);
    const hull=out.fleets.filter(f=>f.ownerId==='aurora').flatMap(f=>f.ships).reduce((n,s)=>n+s.hull,0);
    expect(hull).toBeCloseTo(30-15/(1.1*1.03),2);
  });
  it('首次福利不足当步不享受乌托邦人口加成，维修与冶炼不得挤占账单',async()=>{
    const s=fixture(),f=s.factions.aurora;f.civilization={choice:'utopia',establishedDay:0};f.welfare!.choice='utopian';
    f.resources={energy:0,food:0,minerals:0,alloys:0};s.systems[0].planets[0].structures=[];
    const out=await advanceRound(s,pools[0]);expect(out.factions.aurora.welfare!.last!.fraction).toBe(0);expect(out.systems[0].planets[0].growthDays).toBe(0);
    expect(out.factions.aurora.resources.minerals).toBe(0);expect(out.factions.aurora.resources.alloys).toBe(0);
  });
  it('福利按增长前人口计费，新人口下一十日加入；全额支付不重复扣费',async()=>{
    const s=rich(fixture());s.systems[0].planets[0].growthDays=499;
    const quotes:number[]=[];await advanceRound(s,pools[0],{},async batch=>{for(const item of batch.economy as any[])if(item.factionId==='aurora')quotes.push(item.welfare.population);});
    expect(quotes[0]).toBe(10);expect(quotes[1]).toBe(11);
  });
  it('V5 SSE失败整批撤回永久制度及待遇，重交只承诺一次',async()=>{
    const s=fixture(),before=stateHash(s);let calls=0;
    const oath={type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}};
    const provider=new ModelProvider({base:'https://test.invalid/v1',key:'test-only'},async()=>response([batchCall(++calls===1?[oath,{type:'choose_policy',args:{policy:'utopia'}}]:[oath],`v5-${calls}`)]));
    const d=await provider.decide(s,'aurora',new AbortController().signal);expect(calls).toBe(2);expect(stateHash(s)).toBe(before);expect(d.trace.some(t=>t.disposition==='rolled_back')).toBe(true);
    const final=commitActions(s,{aurora:d.actions});expect(final.factions.aurora.civilization?.choice).toBe('militarist');expect(final.events.filter(e=>e.text.includes('永久确立'))).toHaveLength(1);
  });
  it('被占领国家预测不借用占领军隐藏经济，原主福利照常计失约',()=>{
    const s=rich(fixture());s.systems[0].controllerId='umbra';const original=stateHash(s);
    const projection=economicForecast(s,'aurora');expect(stateHash(s)).toBe(original);expect(projection.horizons[0]).toMatchObject({unpaidDays:720});
    s.factions.umbra.resources.minerals=1;s.factions.umbra.unity=1;expect(economicForecast(s,'aurora')).toEqual(projection);
  });
  it('未来预测不改变原状态，明确保留政策不自动续期',()=>{
    const s=rich(fixture());s.factions.aurora.policy={choice:'exercises',term:0,locked:true,explicit:true};const hash=stateHash(s);
    const result=economicForecast(s,'aurora');expect(stateHash(s)).toBe(hash);expect(result.horizons).toHaveLength(2);expect(result.horizons[0]).toMatchObject({days:720,policy:'none'});
  });
});
