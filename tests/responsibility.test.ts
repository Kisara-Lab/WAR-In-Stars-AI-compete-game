import { afterAll, describe, expect, it } from 'vitest';
import { createGame } from '../src/sim/world.js';
import { DEFAULT_CONFIG, FACTION_PRESETS, units } from '../src/shared/rules.js';
import { responsibilityView, WELFARE_52 } from '../src/shared/responsibility.js';
import { civilizationScore } from '../src/shared/balance.js';
import { welfareQuote, welfareRules } from '../src/shared/civilization.js';
import { relationship } from '../src/shared/diplomacy.js';
import { controller } from '../src/shared/v4.js';
import { applyAction, StagingArea, toolDefinitions } from '../src/sim/actions.js';
import { applyCivilization, migrateResponsibilities, settleWelfare } from '../src/sim/civilization.js';
import { aidedWelfare, applySocialAction, dutyPaths, enforceReform, onWarResponsibility, rescueReasons, updateSocial } from '../src/sim/social.js';
import { createWar, declareWar, settleWar, updateWars } from '../src/sim/wars.js';
import { shortestPath, stateHash } from '../src/sim/math.js';
import { observation, refreshIntel } from '../src/sim/intel.js';
import { decisionComparison } from '../src/sim/options.js';
import { advanceRound, commitActions } from '../src/sim/engine.js';
import { SimulationPool } from '../src/sim/pool.js';
import { ModelProvider } from '../src/server/provider.js';
import { batchCall, response } from './helpers/responses.js';
import { scriptedDecision } from '../src/sim/bot.js';

const game=()=>createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted'},'v52-fixture','5.2');
type State=ReturnType<typeof game>;
const zero=()=>({energy:0,minerals:0,food:0});
const rich=(s:State)=>{for(const f of Object.values(s.factions))f.resources={energy:units(10000),minerals:units(10000),food:units(10000),alloys:units(1000)};return s;};
function peace(s:State,a='aurora',b='umbra'){const r=relationship(s,a,b)!;r.status='peace';r.confirmed=[a,b];r.pactUntil=null;}
function utopia(s:State,a='aurora'){s.factions[a].civilization={choice:'utopia',establishedDay:0};s.factions[a].welfare!.choice='utopian';}
function concern(s:State,target='umbra',actor='aurora'){const c:import('../src/shared/responsibility.js').Concern={id:'test-'+target,target,openedDay:0,known:{[actor]:0},clearDays:0};s.social!.concerns.push(c);return c;}
function pay(s:State,actor:string,fraction=1){const q=welfareQuote(s,actor,10);s.factions[actor].welfare!.last={day:s.day,...q,paid:{energy:Math.round(q.deliverable.energy*fraction),minerals:Math.round(q.deliverable.minerals*fraction),food:Math.round(q.deliverable.food*fraction)},fraction,reasons:[]};}
function tick(s:State,days:number,fractions:Record<string,number>={}){for(let i=0;i<days;i+=10){s.day+=10;for(const a of Object.keys(s.factions))pay(s,a,fractions[a]??1);updateSocial(s);}}
function border(s:State){const home=s.systems.find(x=>x.ownerId==='aurora')!;const t=s.systems.find(x=>home.neighbors.includes(x.id)&&!x.ownerId)!;t.ownerId='umbra';t.base={hull:200};t.planets[0].ownerId='umbra';t.planets[0].population=2;s.factions.aurora.surveyed.push(t.id);s.factions.aurora.intel[t.id]={day:s.day,system:structuredClone(t),fleets:[]};return t;}
const pools=[0,2,8].map(n=>new SimulationPool(n));
afterAll(()=>Promise.all(pools.map(p=>p.close())));

describe('V5.2创教、福利与只读边界',()=>{
 it('教廷小数账单使用整数余数结转，十步总额等于100日费用',()=>{
  const s=rich(game()),f=s.factions.aurora;f.welfare!.choice='church';const due=welfareQuote(s,'aurora',100).due,paid=zero();
  for(let i=0;i<10;i++){s.day+=10;settleWelfare(s,'aurora',zero(),zero());for(const k of ['energy','minerals','food'] as const)paid[k]+=f.welfare!.last!.paid[k];expect(f.welfare!.last!.fraction).toBe(1);}
  expect(paid).toEqual(due);expect(f.welfare!.rounding!.due).toEqual(zero());
 });
 it('4至8方多种子只有两颗候选，满足距离且探索前不揭示',()=>{
  for(const count of [4,5,6,7,8])for(const seed of ['responsibility-a','responsibility-b','responsibility-c']){
   const s=createGame({...DEFAULT_CONFIG,seed,factionIds:FACTION_PRESETS.slice(0,count).map(f=>f.id),systemCount:count*6});
   const homes=Object.values(s.factions).map(f=>f.homeSystemId),holy=s.systems.filter(s=>s.planets.some(p=>p.holyCandidate));
   expect(holy).toHaveLength(2);expect(holy.flatMap(s=>s.planets.filter(p=>p.holyCandidate))).toHaveLength(2);
   expect(shortestPath(s.systems,holy[0].id,holy[1].id)!.length).toBeGreaterThanOrEqual(3);
   for(const h of holy){const ds=homes.map(id=>shortestPath(s.systems,id,h.id)!.length).sort((a,b)=>a-b);expect(homes).not.toContain(h.id);expect(h.neighbors.length).toBeGreaterThanOrEqual(2);expect(ds[0]).toBeGreaterThanOrEqual(1);expect(ds[0]).toBeLessThanOrEqual(2);expect(ds[1]).toBeLessThanOrEqual(4);expect(ds[1]-ds[0]).toBeLessThanOrEqual(2);}
   expect(observation(s,'aurora',null,false).systems.flatMap(s=>s.planets??[]).some(p=>p.holyCandidate)).toBe(false);
  }
 });
 it('拥有控制才能立教，永久登记不随淘汰或失地释放，附属殖民地可祝圣',()=>{
  const s=rich(game()),h=s.systems.find(s=>s.planets.some(p=>p.holyCandidate))!,p=h.planets.find(p=>p.holyCandidate)!;
  s.factions.aurora.surveyed.push(h.id);const args={planetId:p.id,name:'test',doctrine:'test doctrine',acknowledgePermanent:true};
  expect(new StagingArea(s,'aurora').execute('establish_religion',args).ok).toBe(false);
  h.ownerId='aurora';applyAction(s,'aurora',{type:'establish_religion',args},'found');expect(s.social!.founders).toHaveLength(1);
  const home=s.systems.find(x=>x.id===s.factions.aurora.homeSystemId)!;applyAction(s,'aurora',{type:'consecrate',args:{planetId:home.planets.find(p=>p.ownerId==='aurora')!.id}},'secondary');expect(home.projects.some(p=>p.kind==='consecrate')).toBe(true);
  h.ownerId='umbra';s.factions.aurora.eliminatedDay=0;s.factions.umbra.surveyed.push(h.id);
  expect(new StagingArea(s,'umbra').execute('establish_religion',args).ok).toBe(false);expect(s.social!.founders).toHaveLength(1);
 });
 it('同轮两个合法创教登记均保留，第三方后来夺取仍不能创立第三国教',()=>{
  const s=rich(game()),holy=s.systems.filter(x=>x.planets.some(p=>p.holyCandidate)),actions:Record<string,any[]>={};
  for(const [i,actor]of ['aurora','umbra'].entries()){const h=holy[i];h.ownerId=actor;s.factions[actor].surveyed.push(h.id);actions[actor]=[{type:'establish_religion',args:{planetId:h.planets.find(p=>p.holyCandidate)!.id,name:actor,doctrine:'测试独占名额',acknowledgePermanent:true}}];}
  const next=commitActions(s,actions);expect(next.social!.founders).toHaveLength(2);holy[0]=next.systems.find(x=>x.id===holy[0].id)!;holy[0].ownerId='verdant';next.factions.verdant.surveyed.push(holy[0].id);
  const resources=structuredClone(next.factions.verdant.resources);expect(new StagingArea(next,'verdant').execute('establish_religion',actions.aurora[0].args).ok).toBe(false);expect(next.factions.verdant.resources).toEqual(resources);
 });
 it('六档价格隔离旧修订，军国明确选择低档且不能升高福利',()=>{
  const s=rich(game());for(const [id,cost] of Object.entries(WELFARE_52)){const rule=welfareRules(s)[id as keyof typeof WELFARE_52];for(const k of ['energy','minerals','food'] as const)expect(rule[k]).toBe(cost[k]);}
  expect(welfareRules({rulesRevision:'5.0'}).utopian.food).toBe(2);expect(welfareRules({rulesRevision:'5.1'}).comfortable.food).toBe(1);
  s.factions.aurora.welfare!.choice='utopian';const stage=new StagingArea(s,'aurora');expect(stage.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true}).ok).toBe(false);
  expect(stage.execute('establish_civilization',{civilization:'militarist',acknowledgePermanent:true,welfare:'comfortable'}).ok).toBe(true);expect(stage.execute('set_welfare',{welfare:'utopian'}).ok).toBe(false);
 });
 it('所有比较和职责查询只读，外方内部状态不进入受限报告',()=>{
  const s=game();peace(s);concern(s);s.social!.concerns[0].known.verdant=30;s.social!.reports.umbra={target:'umbra',day:0,welfare:'basic',delivery:'below_50',distressed:true};
  const hash=stateHash(s);decisionComparison(s,'aurora');applySocialAction(s,'aurora',{type:'get_responsibilities',args:{}},'query');expect(stateHash(s)).toBe(hash);
  const before=JSON.stringify(responsibilityView(s,'aurora'));s.factions.umbra.resources.minerals=123456789;s.factions.umbra.responsibility!.dissatisfaction=99;expect(JSON.stringify(responsibilityView(s,'aurora'))).toBe(before);expect(responsibilityView(s,'aurora')!.concerns[0].known).toEqual({aurora:0});
 });
 it('隐藏敌舰、库存与旧情报之外的基地变动不改变脚本计划',()=>{
  const s=rich(game()),home=s.systems.find(x=>x.ownerId==='aurora')!,t=s.systems.find(x=>home.neighbors.includes(x.id)&&!x.ownerId)!;s.factions.aurora.surveyed.push(t.id);s.factions.aurora.intel[t.id]={day:0,system:structuredClone(t),fleets:[]};
  const first=scriptedDecision(s,'aurora').actions,hidden=structuredClone(s);hidden.systems.find(x=>x.id===t.id)!.ownerId='umbra';hidden.systems.find(x=>x.id===t.id)!.base={hull:200};hidden.factions.umbra.resources.minerals=99999999;for(const fleet of hidden.fleets.filter(f=>f.ownerId==='umbra'))for(const ship of fleet.ships)ship.hull=9999;
  expect(scriptedDecision(hidden,'aurora').actions).toEqual(first);
 });
 it('迁移四国教拒绝且原状态不变；合法分支只给完整新整备期',()=>{
  const old=createGame(DEFAULT_CONFIG,'old','5.1');for(const [a,f] of Object.entries(old.factions))f.faith={name:a,doctrine:'test',establishedDay:0,crisis:0,sites:[{main:true,planetId:old.systems.find(s=>s.ownerId===a)!.planets[0].id,lossKeys:[],recoveryKeys:[]}],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
  const hash=stateHash(old);expect(()=>migrateResponsibilities(old)).toThrow(/两个/);expect(stateHash(old)).toBe(hash);
  const clean=createGame(DEFAULT_CONFIG,'old-clean','5.1');clean.day=6000;const migrated=migrateResponsibilities(clean);expect(migrated.rulesRevision).toBe('5.2');expect(migrated.factions.aurora.responsibility!.startedDay).toBe(6000);expect(clean.social).toBeUndefined();
 });
 it('新工具及救援枚举只下发新修订，批量包含完整描述',()=>{
  const s=game(),defs=toolDefinitions(true,s),batch=defs.find(t=>t.name==='submit_turn')!;expect(JSON.stringify(batch)).toContain('humanitarian');expect(JSON.stringify(batch)).toContain('offer_aid');expect(JSON.stringify(batch)).toContain('关注/违约');
  const old=createGame(DEFAULT_CONFIG,'old','5.1');expect(JSON.stringify(toolDefinitions(true,old))).not.toContain('humanitarian');expect(toolDefinitions(false,old).some(t=>t.name==='get_responsibilities')).toBe(false);
 });
});

describe('V5.2援助与改革完整链路',()=>{
 it('SSE援助预付后错误整批回滚，纠错重交只托管一次',async()=>{
  const s=rich(game());peace(s);utopia(s);const c=concern(s),hash=stateHash(s),before=s.factions.aurora.resources;
  const aid={type:'offer_aid',args:{factionId:'umbra',concernId:c.id}},bad={type:'build_starbase',args:{systemId:s.factions.aurora.homeSystemId}};let calls=0;
  const provider=new ModelProvider({base:'https://test.invalid/v1',key:'test-secret'},async(_url,init)=>{
   if(++calls===2)expect(JSON.stringify(JSON.parse(init!.body as string).input)).toContain('rolled_back');
   return response([batchCall(calls===1?[aid,bad]:[aid],'aid-retry-'+calls)]);
  });
  const result=await provider.decide(s,'aurora',new AbortController().signal);expect(result.metrics.requests).toBe(2);expect(stateHash(s)).toBe(hash);expect(result.actions).toEqual([aid]);
  const next=commitActions(s,{aurora:result.actions});expect(next.social!.aid).toHaveLength(1);expect(next.factions.aurora.resources.minerals).toBe(before.minerals-units(150));
 });
 it('援助预付、仅补福利、到期返还未用；不流入库存或重复扣费',()=>{
  const s=rich(game());peace(s);utopia(s);const c=concern(s),before=s.factions.aurora.resources.minerals;
  const a=applySocialAction(s,'aurora',{type:'offer_aid',args:{factionId:'umbra',concernId:c.id}},'aid') as any;expect(s.factions.aurora.resources.minerals).toBe(before-units(150));
  s.day=100;s.factions.umbra.welfare!.choice='survival';applySocialAction(s,'umbra',{type:'accept_aid',args:{proposalId:a.id}},'accept');expect(s.factions.umbra.welfare!.choice).toBe('comfortable');s.day=110;
  const resources=structuredClone(s.factions.umbra.resources),due={energy:units(30),minerals:units(15),food:units(30)},paid=aidedWelfare(s,'umbra',zero(),due);
  expect(paid.paid).toEqual(due);expect(paid.selfPaid).toEqual(zero());expect(s.factions.umbra.resources).toEqual(resources);
  s.day=460;updateSocial(s);expect(s.factions.aurora.resources.minerals).toBe(before-units(15));expect(a.endedDay).toBe(460);updateSocial(s);expect(s.factions.aurora.resources.minerals).toBe(before-units(15));
 });
 it('维护优先、援助共同支付比例、没有可交付人口不制造关注',()=>{
  const s=game(),f=s.factions.aurora;f.resources={energy:units(5),minerals:units(10),food:units(10)};s.day=10;const upkeep={energy:units(5),minerals:0,food:0};settleWelfare(s,'aurora',zero(),upkeep);expect(f.welfare!.last!.fraction).toBe(0);expect(upkeep.energy).toBe(units(5));
  const home=s.systems.find(x=>x.ownerId==='aurora')!;home.controllerId='umbra';f.welfare!.choice='survival';tick(s,400,{aurora:0});expect(s.social!.concerns.some(c=>c.target==='aurora')).toBe(false);
 });
 it('低档持续300日公开关注、360日不回应扣分、300日恢复且历史不删',()=>{
  const s=game();peace(s);utopia(s);s.factions.umbra.welfare!.choice='basic';tick(s,300);const c=s.social!.concerns.find(c=>c.target==='umbra')!;expect(c.openedDay).toBe(300);tick(s,360);expect(s.factions.aurora.responsibility!.rescuePenalty).toBe(0);tick(s,100);expect(s.factions.aurora.responsibility!.rescuePenalty).toBe(50);
  s.factions.umbra.welfare!.choice='comfortable';tick(s,300);expect(c.closedDay).toBeDefined();const start=s.factions.aurora.responsibility!.rescuePenalty;expect(start).toBeGreaterThan(0);tick(s,300);expect(s.factions.aurora.responsibility!.rescuePenalty).toBe(0);
 });
 it('真实援助连续改善100日才缓冲，关闭关注才满足责任',()=>{
  const s=rich(game());peace(s);utopia(s);const c=concern(s);s.day=400;
  const a=applySocialAction(s,'aurora',{type:'offer_aid',args:{factionId:'umbra',concernId:c.id}},'aid') as any;s.day=500;applySocialAction(s,'umbra',{type:'accept_aid',args:{proposalId:a.id}},'accept');
  tick(s,90);expect(a.effective).toBeUndefined();expect(s.factions.aurora.responsibility!.ignored).toBe(true);a.spent.food=1;s.factions.umbra.shortages.energy=true;tick(s,100);expect(a.effective).toBe(true);expect(s.factions.aurora.responsibility!.ignored).toBe(false);tick(s,110);expect(c.closedDay).toBeDefined();expect(s.factions.aurora.responsibility!.responses[c.id].fulfilled).toBe(true);
 });
 it('一项真实进展覆盖多个关注，重复空提案不覆盖',()=>{
  const s=game();peace(s);peace(s,'aurora','verdant');utopia(s);concern(s);concern(s,'verdant');s.day=400;enforceReform(s,'aurora','umbra','test-umbra');tick(s,10);expect(s.factions.aurora.responsibility!.ignored).toBe(false);
 });
 it('改革覆盖待遇冷却、主动降档立即违约，理由保留完整条约后窗口',()=>{
  const s=game();peace(s);utopia(s);s.factions.umbra.welfare!.choice='basic';const c=concern(s),r=enforceReform(s,'aurora','umbra',c.id);expect(s.factions.umbra.welfare!.choice).toBe('comfortable');relationship(s,'aurora','umbra')!.pactUntil=1080;
  s.day=360;applyCivilization(s,'umbra',{type:'set_welfare',args:{welfare:'survival'}});expect(r.breachedDay).toBe(360);expect(r.breachExpiresDay).toBe(2160);expect(rescueReasons(s,'aurora').find(x=>x.id==='breach-'+r.id)?.usableDay).toBe(1080);
 });
 it('和平接受改革也签条约；同轮救援宣战被共同结算拒绝，原计划不能绕过',()=>{
  const s=rich(game());peace(s);utopia(s);const t=border(s),c=concern(s);s.day=400;
  const offer=applySocialAction(s,'aurora',{type:'propose_reform',args:{factionId:'umbra',concernId:c.id}},'offer') as any;s.day=500;
  const next=commitActions(s,{aurora:[{type:'declare_war',args:{factionId:'umbra',warType:'humanitarian',systemIds:[t.id],grievanceId:c.id,reason:'test'}}],umbra:[{type:'accept_reform',args:{proposalId:offer.id}}]});
  expect(relationship(next,'aurora','umbra')!.pactUntil).toBe(1580);expect(next.wars).toHaveLength(0);expect(next.social!.reforms[0].acceptedDay).toBe(500);
 });
 it('救援宣战、占领200日、强制改革、不割地、50分去重及条约',()=>{
  const s=rich(game());peace(s);utopia(s);const target=border(s),c=concern(s);s.day=400;
  applyAction(s,'aurora',{type:'declare_war',args:{factionId:'umbra',warType:'humanitarian',systemIds:[target.id],grievanceId:c.id,reason:'test rescue'}},'war');const w=s.wars!.at(-1)!;
  target.controllerId='aurora';target.occupationWarId=w.id;w.hadHostilities=true;w.goals.aurora[0].heldDays=200;
  applyAction(s,'aurora',{type:'enforce_peace',args:{factionId:'umbra'}},'peace');expect(target.ownerId).toBe('umbra');expect(controller(target)).toBe('umbra');expect(s.social!.reforms).toHaveLength(1);expect(relationship(s,'aurora','umbra')!.pactUntil).toBe(1480);expect(s.warAchievements!.filter(a=>a.type==='humanitarian')).toHaveLength(1);settleWar(s,w,true,'repeat');expect(s.social!.reforms).toHaveLength(1);
  tick(s,350);expect(s.social!.reforms[0].effective).toBeUndefined();tick(s,10);expect(s.social!.reforms[0].effective).toBe(true);expect(s.factions.aurora.responsibility!.responses[c.id].fulfilled).toBe(true);
 });
 it('早期接受救援改革可停战但不立即授予责任成果或战争分',()=>{
  const s=game();peace(s);utopia(s);const target=border(s),c=concern(s);const w=declareWar(s,'aurora','umbra','humanitarian',[target.id],'test');w.humanitarianReasons={aurora:c.id};s.day=100;
  applySocialAction(s,'umbra',{type:'accept_reform',args:{proposalId:w.id}},'accept');expect(w.endedDay).toBe(100);expect(s.social!.reforms[0].effective).toBeUndefined();expect(s.warAchievements).toEqual([]);
 });
 it('救援目标已被第三方取得时无协议无授分；空战期限正常结束',()=>{
  const s=game();peace(s);utopia(s);const t=border(s),w=declareWar(s,'aurora','umbra','humanitarian',[t.id],'test');w.goals.aurora[0].heldDays=200;t.ownerId='verdant';t.controllerId='aurora';settleWar(s,w,true,'third party');expect(s.social!.reforms).toHaveLength(0);expect(t.ownerId).toBe('verdant');
 });
});

describe('V5.2责任时钟、恢复与失败反馈',()=>{
 it('军国720日整备、资源不足不停表、空战不缓冲、真实作战最多360日',()=>{
  const s=game();peace(s);border(s);applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}});s.factions.aurora.resources=zero();
  tick(s,720);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(0);tick(s,100);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(5);
  const w=createWar(s,['aurora','umbra'],'limited');w.attackers=['aurora'];tick(s,100);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(10);w.hadHostilities=true;tick(s,360);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(10);tick(s,100);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(15);
  settleWar(s,w,false,'failed');expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(35);settleWar(s,w,false,'again');expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(35);
 });
 it('没有路径暂停；条约期间可以准备征服仍可行动；实际防御成功也履责',()=>{
  const s=game();applyCivilization(s,'aurora',{type:'establish_civilization',args:{civilization:'militarist',acknowledgePermanent:true}});tick(s,900);expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(0);
  peace(s);border(s);relationship(s,'aurora','umbra')!.pactUntil=3000;expect(dutyPaths(s,'aurora').actionable).toBe(true);
  const w=createWar(s,['aurora','umbra'],'limited');w.attackers=['umbra'];w.hadHostilities=true;s.factions.aurora.responsibility!.dissatisfaction=75;settleWar(s,w,false,'defense');expect(s.factions.aurora.responsibility!.dissatisfaction).toBe(0);expect(s.factions.aurora.responsibility!.satisfiedUntil).toBe(s.day+1800);
 });
 it('国教1080整备、6/10危机压力、成果须保有实际传教权',()=>{
  const s=game();peace(s);border(s);const f=s.factions.aurora;f.civilization={choice:'theocracy',establishedDay:0};f.faith={name:'test',doctrine:'test',establishedDay:0,crisis:0,sites:[],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
  tick(s,1080);expect(f.faith.pending).toHaveLength(0);tick(s,720);expect(f.faith.pending.reduce((n,p)=>n+p.amount,0)).toBeCloseTo(43.2);tick(s,100);expect(f.faith.pending.slice(-10).reduce((n,p)=>n+p.amount,0)).toBeCloseTo(10);
  const w=createWar(s,['aurora','umbra'],'missionary');w.attackers=['aurora'];s.missions!.push({id:'test-mission',warId:w.id,religionId:'aurora',hostId:'umbra',systemId:s.factions.umbra.homeSystemId,startsDay:s.day,expiresDay:s.day+1800});onWarResponsibility(s,w,new Set(['aurora']));expect(f.responsibility!.satisfiedUntil).toBe(s.day+1800);expect(f.responsibility!.missionIds).toEqual(['test-mission']);onWarResponsibility(s,w,new Set(['aurora']));expect(f.responsibility!.missionIds).toHaveLength(1);
  const lostDay=s.day;s.missions![0].expiresDay=lostDay;w.endedDay=lostDay;peace(s);tick(s,10);expect(f.responsibility!.satisfiedUntil).toBe(lostDay);expect(f.responsibility!.last!.pressure).toBeGreaterThan(0);
 });
 it('基地共同结算失败聚合，未更新情报禁止重复且不泄露所有者',()=>{
  const s=rich(game()),home=s.systems.find(x=>x.ownerId==='aurora')!,t=s.systems.find(x=>home.neighbors.includes(x.id)&&!x.ownerId)!;s.factions.aurora.surveyed.push(t.id);s.factions.aurora.intel[t.id]={day:0,system:structuredClone(t),fleets:[]};t.ownerId='umbra';t.base={hull:200};
  const committed=commitActions(s,{aurora:[{type:'build_starbase',args:{systemId:t.id}}]});const f=committed.factions.aurora.failedOrders!['build_starbase:'+t.id];expect(f.count).toBe(1);const result=new StagingArea(committed,'aurora').execute('build_starbase',{systemId:t.id});expect(result.ok).toBe(false);expect(result.error).not.toContain('umbra');expect(result.error).toContain('情报');
 });
 it('0/2/8 worker及JSON中途恢复，含援助责任与战争状态哈希一致',async()=>{
  const s=rich(game());peace(s);utopia(s);const c=concern(s);s.day=400;const a=applySocialAction(s,'aurora',{type:'offer_aid',args:{factionId:'umbra',concernId:c.id}},'aid') as any;s.day=500;applySocialAction(s,'umbra',{type:'accept_aid',args:{proposalId:a.id}},'accept');border(s);createWar(s,['verdant','cobalt'],'limited').hadHostilities=true;
  const results=await Promise.all(pools.map(p=>advanceRound(s,p)));expect(new Set(results.map(stateHash)).size).toBe(1);
  const continuous=await advanceRound(results[0],pools[0]),restored=await advanceRound(JSON.parse(JSON.stringify(results[0])),pools[1]);expect(stateHash(restored)).toBe(stateHash(continuous));
 });
});
