import { afterAll, describe, expect, it } from 'vitest';
import { createGame } from '../src/sim/world.js';
import { DEFAULT_CONFIG, units } from '../src/shared/rules.js';
import { applyAction, StagingArea, toolDefinitions } from '../src/sim/actions.js';
import { advanceRound, economyFactors, settleEconomy, commitActions } from '../src/sim/engine.js';
import { SimulationPool } from '../src/sim/pool.js';
import { processLocal } from '../src/sim/local.js';
import { freezeOperations } from '../src/shared/industry.js';
import { updateSocial, rescueReasons } from '../src/sim/social.js';
import { createWar, settleWar, updateWars } from '../src/sim/wars.js';
import { applyExtractionRecovery, applyEmergency, discoverExtractions, extractionDuty, migrateEmergency } from '../src/sim/emergency.js';
import { emergencyView, extractingAt, recoveryFraction } from '../src/shared/emergency.js';
import { welfareQuote } from '../src/shared/civilization.js';
import { relationship } from '../src/shared/diplomacy.js';
import { governanceSample } from '../src/shared/governance.js';
import { viewpoint } from '../src/shared/viewpoint.js';
import { settlementPreview } from '../src/shared/settlement-preview.js';
import { finishBalanceInterval } from '../src/sim/balance.js';
import { stateHash } from '../src/sim/math.js';
import { decisionComparison } from '../src/sim/options.js';
import { ModelProvider } from '../src/server/provider.js';
import { batchCall, response } from './helpers/responses.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchStore } from '../src/server/storage.js';
import { MatchRunner } from '../src/server/runner.js';

const pools=[0,2,8].map(n=>new SimulationPool(n));
afterAll(()=>Promise.all(pools.map(p=>p.close())));
const game=()=>{
  const s=createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted'},'emergency-fixture');
  const f=s.factions.umbra;
  f.civilization={choice:'theocracy',establishedDay:0};f.welfare!.choice='church';f.unity=0;
  f.faith={name:'fixture faith',doctrine:'isolated artificial test',establishedDay:0,crisis:100,sites:[],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
  s.factions.aurora.civilization={choice:'utopia',establishedDay:0};s.factions.aurora.welfare!.choice='utopian';
  const r=relationship(s,'aurora','umbra')!;r.status='peace';r.confirmed=['aurora','umbra'];r.pactUntil=null;
  return s;
};
type State=ReturnType<typeof game>;
const act=(s:State,actor:string,type:string,args:Record<string,unknown>={})=>applyAction(s,actor,{type,args},`${actor}-${type}-${s.day}`);
const activate=(s:State)=>act(s,'umbra','activate_extraction');
function economy(s:State) {
  freezeOperations(s);s.day+=10;const factors=economyFactors(s);
  const out=processLocal({phase:'economy',day:s.day,seed:s.config.seed,systems:s.systems,fleets:s.fleets.filter(f=>f.systemId),factions:factors,relations:s.relations,wars:s.wars});
  return {audit:settleEconomy(s,[out],factors,true),factors,out};
}
function border(s:State){const home=s.systems.find(x=>x.ownerId==='aurora')!,t=s.systems.find(x=>home.neighbors.includes(x.id)&&!x.ownerId)!;t.ownerId='umbra';t.base={hull:200};t.planets[0].ownerId='umbra';t.planets[0].population=2;s.factions.aurora.surveyed.push(t.id);s.factions.aurora.intel[t.id]={day:s.day,system:structuredClone(t),fleets:[]};return t;}
function demand(s:State){activate(s);act(s,'aurora','demand_stop_extraction',{factionId:'umbra',eventId:s.factions.umbra.extraction!.id});return s.factions.umbra.extraction!.demands[0];}
function paid(s:State,actor:string,fraction=1){const q=welfareQuote(s,actor,10);s.factions[actor].welfare!.last={...q,day:s.day,paid:{energy:Math.floor(q.deliverable.energy*fraction),minerals:Math.floor(q.deliverable.minerals*fraction),food:Math.floor(q.deliverable.food*fraction)},fraction,reasons:[]};}

describe('5.4什四税经济、评分及版本',()=>{
 it('默认5.4继承费用和48动作，新工具只下发5.4；迁移保留资产且不可重置资格',()=>{
  const s=game();expect(s.rulesRevision).toBe('5.4');expect(s.version).toBe(5);expect(toolDefinitions(true,s).find(x=>x.name==='submit_turn')!.parameters).toHaveProperty('properties.orders.maxItems',48);
  expect(JSON.stringify(toolDefinitions(true,s))).toContain('activate_extraction');
  const old={...s,rulesRevision:'5.3' as const};expect(JSON.stringify(toolDefinitions(true,old))).not.toContain('activate_extraction');
  const hash=stateHash(old),branch=migrateEmergency(old);expect(stateHash(old)).toBe(hash);expect(branch.factions.umbra.resources).toEqual(old.factions.umbra.resources);
  activate(branch);expect(()=>activate(branch)).toThrow('一次');const again=migrateEmergency(branch);expect(again.factions.umbra.extraction).toEqual(branch.factions.umbra.extraction);
 });
 it('基础维护及完整福利前入账，额外10%不制造合金或反复支付',()=>{
  const s=game(),f=s.factions.umbra;f.resources={energy:0,minerals:0,food:0,alloys:0};activate(s);const {audit}=economy(s),e=f.extraction!;
  expect(f.welfare!.last!.fraction).toBe(1);expect(Object.values(f.shortages).some(Boolean)).toBe(false);
  expect(f.resources.alloys).toBe(0);expect(f.resources.food).toBeGreaterThan(0);
  for(const k of ['energy','minerals','food'] as const){expect(e.last!.grant[k]).toBe(Math.round(Math.max(0,e.last!.eligible[k]+e.last!.welfare[k]*1.1-e.last!.normalProduction[k])));expect(e.totalGrant[k]).toBe(e.last!.grant[k]);}
  expect(audit.find(r=>r.factionId==='umbra')!.specialSubsidy).toEqual(e.last);
 });
 it('新舰船、战争维护和维修不托底；合并及拆分舰队不扩张资格',()=>{
  const baseline=game();activate(baseline);const added=structuredClone(baseline),fl=added.fleets.find(f=>f.ownerId==='umbra')!;
  fl.ships.push({id:'new-unprotected',type:'dreadnought',hull:200});
  const normal=structuredClone(baseline);economy(normal);economy(added);
  expect(added.factions.umbra.extraction!.last!.grant).toEqual(normal.factions.umbra.extraction!.last!.grant);
  expect(added.factions.umbra.extraction!.last!.uncovered.energy).toBeGreaterThan(0);
  const split=structuredClone(baseline),fleet=split.fleets.find(f=>f.ownerId==='umbra')!,ship=fleet.ships.pop()!;split.fleets.push({...structuredClone(fleet),id:'split',ships:[ship]});economy(split);
  expect(split.factions.umbra.extraction!.last!.grant).toEqual(normal.factions.umbra.extraction!.last!.grant);
  const warState=structuredClone(baseline);const w=createWar(warState,['umbra','aurora'],'total');w.attackers=['umbra'];economy(warState);
  expect(warState.factions.umbra.extraction!.last!.grant).toEqual(normal.factions.umbra.extraction!.last!.grant);
 });
 it('在途与驻留舰船一致，损失后不再报销；已存在维护折扣不能借迁移位置增加额度',()=>{
  const s=game();activate(s);const a=structuredClone(s),b=structuredClone(s);const fl=b.fleets.find(f=>f.ownerId==='umbra')!;fl.systemId=null;fl.transit={from:'s0',to:'s1',remainingDays:100};economy(a);economy(b);expect(b.factions.umbra.extraction!.last!.grant).toEqual(a.factions.umbra.extraction!.last!.grant);
  const lost=structuredClone(s);lost.fleets=lost.fleets.filter(f=>f.ownerId!=='umbra');economy(lost);expect(lost.factions.umbra.extraction!.last!.eligible.energy).toBeLessThan(a.factions.umbra.extraction!.last!.eligible.energy);
 });
 it('占领人口不补不可交付福利，原主仍记未兑现',()=>{
  const s=game(),home=s.systems.find(x=>x.ownerId==='umbra')!;home.controllerId='aurora';activate(s);economy(s);expect(s.factions.umbra.extraction!.last!.welfare.food).toBe(0);expect(s.factions.umbra.welfare!.last!.fraction).toBe(0);
 });
 it('恢复轨迹精确到1800日；低危机不提高、高凝聚力不锁原值；到期保护停止',()=>{
  const s=game();activate(s);s.day=900;applyExtractionRecovery(s);expect(s.factions.umbra.faith!.crisis).toBe(59.5);expect(s.factions.umbra.unity).toBe(3000);
  s.day=1800;applyExtractionRecovery(s);expect(s.factions.umbra.faith!.crisis).toBe(19);expect(s.factions.umbra.unity).toBe(6000);
  s.day=1810;s.factions.umbra.unity=0;s.factions.umbra.faith!.crisis=100;applyExtractionRecovery(s);expect(s.factions.umbra.unity).toBe(0);expect(s.factions.umbra.faith!.crisis).toBe(100);
  const high=game();high.factions.umbra.faith!.crisis=5;high.factions.umbra.unity=9000;activate(high);high.day=10;high.factions.umbra.unity=5000;applyExtractionRecovery(high);expect(high.factions.umbra.unity).toBe(6000);expect(high.factions.umbra.faith!.crisis).toBe(5);
 });
 it('停止后舰船补助归零、民生逐步退出且不能重开；期末不再发补助',()=>{
  const s=game();activate(s);s.day=600;act(s,'umbra','stop_extraction');const e=s.factions.umbra.extraction!;expect(e.expiresDay).toBe(1800);expect(recoveryFraction(e,600)).toBe(1);expect(recoveryFraction(e,1200)).toBe(.5);
  economy(s);expect(e.last!.mode).toBe('recovery');expect(e.last!.uncovered.energy).toBeGreaterThan(0);expect(()=>activate(s)).toThrow('一次');
  s.day=1800;const total=structuredClone(e.totalGrant);economy(s);expect(e.totalGrant).toEqual(total);
 });
 it('征收Q封顶，任期只要重叠就失格；停止后Q恢复，历史成果不删除',()=>{
  const s=game(),f=s.factions.umbra;f.faith!.crisis=0;f.unity=10000;activate(s);s.day=10;paid(s,'umbra');expect(governanceSample(f,10).quality).toBe(500000);
  s.civilizationAwards=[{actor:'umbra',category:'faith',term:-1,day:0,dedupKey:'history'}];
  f.stableFaith={term:0,totalDays:710,qualifiedDays:710,wholeTerm:true};s.day=720;const factors=economyFactors(s);factors.umbra.stableFaithInterval=true;finishBalanceInterval(s,factors,{});expect(s.civilizationAwards).toHaveLength(1);
  act(s,'umbra','stop_extraction');s.day=730;expect(governanceSample(f,s.day).quality).toBe(850000);
 });
 it('启用和停止不能在同批互相掩盖；旧修订拒绝新命令',()=>{
  const s=game(),stage=new StagingArea(s,'umbra');expect(stage.execute('activate_extraction',{}).ok).toBe(true);expect(stage.execute('stop_extraction',{}).ok).toBe(false);
  s.rulesRevision='5.3';expect(new StagingArea(s,'umbra').execute('activate_extraction',{}).ok).toBe(false);
 });
});

describe('5.4停止要求、救援和信息边界',()=>{
 it('首次接触交火不视为正式联系，不提前发布征收报告',()=>{
  const s=game();createWar(s,['cobalt','umbra'],'contact');activate(s);expect(s.factions.umbra.extraction!.known.cobalt).toBeUndefined();
  const war=s.wars!.find(w=>w.factions.includes('cobalt'))!;settleWar(s,war,false,'正式和平');discoverExtractions(s);expect(s.factions.umbra.extraction!.known.cobalt).toBe(0);
 });
 it('没有实际经过新区间时，发现、重复结算和新国教启用不能刷360日履责',()=>{
  const s=game(),d=demand(s);s.day=100;act(s,'umbra','accept_stop_extraction',{demandId:d.id});s.day=110;paid(s,'umbra');
  discoverExtractions(s,true);const e=s.factions.umbra.extraction!;expect(e.qualifiedDays).toBe(10);
  discoverExtractions(s,true);discoverExtractions(s);expect(e.qualifiedDays).toBe(10);
 });
 it('停止后的协议违约生成独立理由，条约到期后仍保留1080日窗口',()=>{
  const s=game(),d=demand(s);s.day=100;act(s,'umbra','accept_stop_extraction',{demandId:d.id});
  for(let n=0;n<60;n++){s.day+=10;for(const a of Object.keys(s.factions))paid(s,a,a==='umbra'?.5:1);updateSocial(s);}
  const reform=s.social!.reforms[0];expect(reform.breachedDay).toBeDefined();expect(reform.breachExpiresDay).toBe(1180+1080);
  const reasons=rescueReasons(s,'aurora');expect(reasons.some(r=>r.id===s.factions.umbra.extraction!.id)).toBe(false);expect(reasons.find(r=>r.id==='breach-'+reform.id)!.usableDay).toBe(1180);
 });
 it('一份停止协议结束多国针对同一事件的救援战，只有强制取得协议的一方授分',()=>{
  const s=game(),target=border(s);demand(s);s.day=180;
  act(s,'aurora','declare_war',{factionId:'umbra',warType:'humanitarian',systemIds:[target.id],grievanceId:s.factions.umbra.extraction!.id,reason:'test'});
  const w=s.wars!.at(-1)!;target.controllerId='aurora';target.occupationWarId=w.id;w.goals.aurora[0].heldDays=200;
  const other=createWar(s,['verdant','umbra'],'humanitarian');other.attackers=['verdant'];other.humanitarianReasons={verdant:s.factions.umbra.extraction!.id};other.goals.verdant=[{type:'humanitarian',systemId:target.id,heldDays:0}];
  act(s,'aurora','enforce_peace',{factionId:'umbra'});expect(s.wars!.every(w=>w.endedDay!==undefined)).toBe(true);expect(s.social!.reforms).toHaveLength(1);expect(s.warAchievements!.filter(a=>a.type==='humanitarian')).toHaveLength(1);
 });
 it('主动停止与第三方目标变化不会让后续强制议和重复授分',()=>{
  const s=game(),t=border(s);demand(s);s.day=180;act(s,'aurora','declare_war',{factionId:'umbra',warType:'humanitarian',systemIds:[t.id],grievanceId:s.factions.umbra.extraction!.id,reason:'test'});const w=s.wars!.at(-1)!;t.controllerId='aurora';t.occupationWarId=w.id;w.goals.aurora[0].heldDays=200;
  act(s,'umbra','stop_extraction');settleWar(s,w,true,'no duplicate');expect(s.warAchievements!.filter(a=>a.type==='humanitarian')).toHaveLength(0);
  const second=game(),t2=border(second);demand(second);second.day=180;act(second,'aurora','declare_war',{factionId:'umbra',warType:'humanitarian',systemIds:[t2.id],grievanceId:second.factions.umbra.extraction!.id,reason:'test'});t2.ownerId='cobalt';updateWars(second);expect(second.wars!.at(-1)!.endedDay).toBe(180);expect(second.factions.umbra.extraction!.stoppedDay).toBeUndefined();
 });
 it('干净轮边界恢复只读，既有存档及审计文件字节保持不变',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stars-v54-clean-')),store=new MatchStore(dir),pool=new SimulationPool(0),state=game();
  const runner=new MatchRunner(state,pool,store,async()=>{throw Error('No paid provider');});
  try{await runner.initialize();const files=await readdir(join(dir,state.id));const before=await Promise.all(files.map(f=>readFile(join(dir,state.id,f))));const checkpoint=await store.load(state.id);await runner.recover(checkpoint);for(const [i,file]of files.entries())expect(await readFile(join(dir,state.id,file))).toEqual(before[i]);expect(runner.status.phase).toBe('paused');expect(runner.status.running).toBe(false);}finally{await pool.close();await rm(dir,{recursive:true,force:true});}
 });
 it('180日要求和180日通牒，拒绝提前开放；互不侵犯只阻止战争不阻止要求',()=>{
  const s=game();border(s);activate(s);s.day=180;relationship(s,'aurora','umbra')!.pactUntil=1000;
  act(s,'aurora','demand_stop_extraction',{factionId:'umbra',eventId:s.factions.umbra.extraction!.id});expect(rescueReasons(s,'aurora').at(-1)!.usableDay).toBe(1000);
  expect(()=>act(s,'aurora','demand_stop_extraction',{factionId:'umbra',eventId:s.factions.umbra.extraction!.id})).toThrow('刷新');
  s.day=190;act(s,'umbra','reject_stop_extraction',{demandId:s.factions.umbra.extraction!.demands[0].id});relationship(s,'aurora','umbra')!.pactUntil=null;expect(rescueReasons(s,'aurora').at(-1)!.usableDay).toBe(190);
 });
 it('未提出要求会追责；条约或无已知目标暂停军事追责，敌方隐藏军力不改变结果',()=>{
  const s=game();border(s);activate(s);s.day=190;expect(extractionDuty(s,'aurora').ignored).toBe(true);
  act(s,'aurora','demand_stop_extraction',{factionId:'umbra',eventId:s.factions.umbra.extraction!.id});s.day=380;
  const hash=stateHash(s),a=extractionDuty(s,'aurora');expect(a.ignored).toBe(true);expect(stateHash(s)).toBe(hash);
  const hidden=structuredClone(s);hidden.factions.umbra.resources.food=99999999;hidden.fleets.find(f=>f.ownerId==='umbra')!.ships.push({id:'secret',type:'dreadnought',hull:999999});expect(extractionDuty(hidden,'aurora')).toEqual(a);
  relationship(s,'aurora','umbra')!.pactUntil=1000;expect(extractionDuty(s,'aurora').ignored).toBe(false);
  relationship(s,'aurora','umbra')!.pactUntil=null;s.factions.aurora.intel={};s.factions.aurora.surveyed=[];expect(extractionDuty(s,'aurora').ignored).toBe(false);
 });
 it('空宣战不履责，有实际交火才用720日缓冲；普通援助不能掩盖强制征收责任',()=>{
  const s=game(),target=border(s);demand(s);s.day=180;act(s,'aurora','declare_war',{factionId:'umbra',warType:'humanitarian',systemIds:[target.id],grievanceId:s.factions.umbra.extraction!.id,reason:'test'});s.day=190;
  expect(extractionDuty(s,'aurora').ignored).toBe(true);s.wars!.at(-1)!.hadHostilities=true;expect(extractionDuty(s,'aurora').ignored).toBe(false);
  s.factions.umbra.extraction!.responses.aurora.bufferedDays=720;expect(extractionDuty(s,'aurora').ignored).toBe(true);
 });
 it('无条件停战不停止征收；200日强制协议停征不割地并一次授分',()=>{
  const s=game(),target=border(s);demand(s);s.day=180;act(s,'aurora','declare_war',{factionId:'umbra',warType:'humanitarian',systemIds:[target.id],grievanceId:s.factions.umbra.extraction!.id,reason:'test'});
  let w=s.wars!.at(-1)!;target.controllerId='aurora';target.occupationWarId=w.id;w.goals.aurora[0].heldDays=200;
  const copy=structuredClone(s);expect(settlementPreview(copy,'aurora',copy.wars!.at(-1)!)!.extraction!.unconditional).toContain('不会');settleWar(copy,copy.wars!.at(-1)!,false,'unconditional');expect(copy.factions.umbra.extraction!.stoppedDay).toBeUndefined();
  act(s,'aurora','enforce_peace',{factionId:'umbra'});expect(s.factions.umbra.extraction!.stoppedDay).toBe(180);expect(target.ownerId).toBe('umbra');expect(target.controllerId).toBeUndefined();expect(relationship(s,'aurora','umbra')!.pactUntil).toBe(1260);
  expect(s.warAchievements!.filter(a=>a.actor==='aurora'&&a.type==='humanitarian')).toHaveLength(1);expect(rescueReasons(s,'aurora').some(r=>r.id===s.factions.umbra.extraction!.id)).toBe(false);
 });
 it('提前接受无战争分，停止后连续合格360日，期间供应坏则重新累计',()=>{
  const s=game(),d=demand(s);s.day=100;act(s,'umbra','accept_stop_extraction',{demandId:d.id});const e=s.factions.umbra.extraction!;expect(e.stoppedDay).toBe(100);expect(s.warAchievements).toHaveLength(0);
  for(let i=0;i<35;i++){s.day+=10;paid(s,'umbra');discoverExtractions(s,true);}expect(e.fulfilledDay).toBeUndefined();s.day+=10;paid(s,'umbra',.5);discoverExtractions(s,true);expect(e.qualifiedDays).toBe(0);
  for(let i=0;i<36;i++){s.day+=10;paid(s,'umbra');discoverExtractions(s,true);}expect(e.fulfilledDay).toBe(s.day);
 });
 it('征收责任与普通关注不叠加；国教压力暂停至原到期，历史逾期不清零',()=>{
  const s=game();activate(s);s.factions.umbra.responsibility!.overdueDays=800;
  s.social!.concerns.push({id:'ordinary',target:'umbra',openedDay:0,known:{aurora:0},clearDays:0});s.day=1190;for(const a of Object.keys(s.factions))paid(s,a);updateSocial(s);
  expect(s.factions.umbra.responsibility!.overdueDays).toBe(800);expect(s.factions.umbra.responsibility!.last!.pressure).toBe(0);expect(s.factions.aurora.responsibility!.rescuePenalty).toBe(5);
 });
 it('共同结算接受先于宣战，原世界不变且不会出现继续征收的新战争',()=>{
  const s=game(),target=border(s),d=demand(s);s.day=200;const hash=stateHash(s);const next=commitActions(s,{umbra:[{type:'accept_stop_extraction',args:{demandId:d.id}}],aurora:[{type:'declare_war',args:{factionId:'umbra',warType:'humanitarian',systemIds:[target.id],grievanceId:s.factions.umbra.extraction!.id,reason:'test'}}]});expect(stateHash(s)).toBe(hash);expect(next.factions.umbra.extraction!.stoppedDay).toBe(200);expect(next.wars?.some(w=>w.endedDay===undefined)).toBe(false);
 });
 it('查看、比较只读；外国只看事件和自己的通牒，不泄露补助、舰船或第三方交涉',()=>{
  const s=game();activate(s);const e=s.factions.umbra.extraction!;e.demands.push({id:'foreign',actor:'verdant',day:0,deadline:180});const h=stateHash(s);emergencyView(s,'aurora');decisionComparison(s,'aurora');expect(stateHash(s)).toBe(h);
  const v=emergencyView(s,'aurora')!;expect(v.own).toBeNull();expect(JSON.stringify(v)).not.toContain('foreign');expect(viewpoint(s,'aurora').factions.umbra.extraction!.ships).toEqual({});expect(viewpoint(s,'cobalt').factions.umbra.extraction).toBeUndefined();
 });
 it('混合经济、恢复、社会责任在0/2/8 workers及序列化恢复保持相同哈希',async()=>{
  const s=game();activate(s);const values=await Promise.all(pools.map(p=>advanceRound(s,p)));expect(new Set(values.map(stateHash)).size).toBe(1);
  const a=await advanceRound(values[0],pools[0]),b=await advanceRound(JSON.parse(JSON.stringify(values[0])),pools[1]);expect(stateHash(a)).toBe(stateHash(b));expect(a.factions.umbra.governance).toHaveLength(20);
 });
 it('SSE错误批次回滚启用资格，修正重交只接受一次并使用8192输出',async()=>{
  const s=game(),h=stateHash(s);let requests=0;const bodies:any[]=[];
  const provider=new ModelProvider({key:'test',base:'https://test.invalid'},async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));const bad=requests++===0;return response([batchCall(bad?[{type:'activate_extraction',args:{}},{type:'queue_ships',args:{planetId:'missing',shipType:'destroyer',count:1}}]:[{type:'activate_extraction',args:{}}],String(requests))]);});
  const d=await provider.decide(s,'umbra',new AbortController().signal,()=>{},()=>{});expect(requests).toBe(2);expect(d.actions).toHaveLength(1);expect(d.trace.some(t=>t.name==='activate_extraction'&&t.disposition==='rolled_back')).toBe(true);expect(bodies[0].max_output_tokens).toBe(8192);expect(stateHash(s)).toBe(h);
 });
});
