import { expect, test } from '@playwright/test';
import { DEFAULT_CONFIG, factionRecord, units } from '../../src/shared/rules.js';
import { createGame } from '../../src/sim/world.js';
import { emptyMetrics } from '../../src/sim/bot.js';
import { declareWar } from '../../src/sim/wars.js';

test('5.2创教、责任、救援、援助、协议、评分及受限视角',async({page})=>{
 const state=createGame({...DEFAULT_CONFIG,controller:'scripted'},'browser-responsibility','5.2');state.day=600;
 const f=state.factions.aurora;f.civilization={choice:'utopia',establishedDay:0};f.welfare!.choice='utopian';f.responsibility!.rescuePenalty=125;f.responsibility!.ignored=true;
 f.failedOrders={'build_starbase:s11':{type:'build_starbase',target:'s11',count:3,day:500,intelDay:400,reason:'旧情报未确认可施工'}};
 const relation=Object.values(state.relations).find(r=>r.factions.includes('aurora')&&r.factions.includes('umbra'))!;relation.status='peace';relation.confirmed=['aurora','umbra'];
 state.social!.reports.umbra={target:'umbra',day:600,welfare:'basic',delivery:'below_50',distressed:true};
 state.social!.concerns.push({id:'concern-fixture',target:'umbra',openedDay:200,known:{aurora:200},clearDays:0});
 state.social!.aid.push({id:'aid-fixture',actor:'aurora',target:'umbra',concernId:'concern-fixture',createdDay:400,acceptedDay:500,expiresDay:860,remaining:{energy:units(250),minerals:units(100),food:units(200)},spent:{energy:units(50),minerals:units(50),food:units(100)},improvedDays:100,effective:true});
 state.social!.reforms.push({id:'reform-fixture',actor:'aurora',target:'umbra',concernId:'concern-fixture',createdDay:400,offerUntil:580,acceptedDay:500,expiresDay:1580,history:[],qualifiedDays:90,failedDays:0});
 const candidate=state.systems.flatMap(s=>s.planets).find(p=>p.holyCandidate)!;state.social!.founders.push({planetId:candidate.id,actor:'umbra',day:100});
 const war=declareWar(state,'aurora','umbra','humanitarian',[state.factions.umbra.homeSystemId],'民生救援测试场景');war.goals.aurora[0].heldDays=120;
 const snapshot={state,lastDecisions:null,status:{phase:'paused',running:false,busy:false,error:null,ai:factionRecord(state.config.factionIds,()=>({status:'等待',requests:0,actions:0})),metrics:factionRecord(state.config.factionIds,emptyMetrics),workers:[]}};
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',s=>s.send(JSON.stringify(snapshot)));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await page.getByLabel('观察势力').selectOption('aurora');
 const panel=page.getByLabel('文明责任与民生救援');await expect(panel).toContainText('aid-fixture');await expect(panel).toContainText('reform-fixture');await expect(panel).toContainText('125.0');await expect(panel).toContainText('低于50%');await expect(panel).toContainText('两个永久创教资格');
 await expect(page.locator('.institutions')).toContainText('累计失败3次');await expect(page.locator('.institutions')).toContainText('最近第500日');
 await page.screenshot({path:'.data/verification/v52/responsibility-ui.png',fullPage:true});
 await page.getByLabel('观察势力').selectOption('verdant');await expect(page.getByLabel('文明责任与民生救援')).not.toContainText('aid-fixture');await expect(page.getByLabel('文明责任与民生救援')).not.toContainText('reform-fixture');await expect(page.getByLabel('文明责任与民生救援')).not.toContainText('低于50%');expect(errors).toEqual([]);
});

test('5.2默认、只读查询和导出包含责任与规则出处',async({page})=>{
 const created=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted'}});expect(created.ok()).toBe(true);const initial=await created.json();expect(initial.state.rulesRevision).toBe('5.4');
 const comparison=await page.request.get(`/api/matches/${initial.state.id}/rounds/0/comparison/aurora`);expect((await comparison.json()).responsibilities.rules.holyCount).toBe(2);
 expect((await(await page.request.get('/api/state')).json()).state).toEqual(initial.state);
 const markdown=await page.request.get(`/api/matches/${initial.state.id}/export/markdown`);expect(await markdown.text()).toContain('创教资格、文明责任与民生救援');
 const audit=await page.request.get(`/api/matches/${initial.state.id}/export/jsonl`);expect(await audit.text()).toContain('religiousGrace');
});
