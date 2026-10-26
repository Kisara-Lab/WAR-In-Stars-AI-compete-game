import {expect,test} from '@playwright/test';
import {DEFAULT_CONFIG,factionRecord} from '../../src/shared/rules.js';
import {createGame} from '../../src/sim/world.js';
import {emptyMetrics} from '../../src/sim/bot.js';
test('V5制度、福利、政策、比较与受限视角',async({page})=>{
 const state=createGame({...DEFAULT_CONFIG,controller:'scripted'},'browser-v5');
 state.factions.aurora.civilization={choice:'utopia',establishedDay:0};state.factions.aurora.welfare!.choice='utopian';
 const snapshot={state,lastDecisions:null,status:{phase:'paused',running:false,busy:false,error:null,ai:factionRecord(state.config.factionIds,()=>({status:'等待',requests:0,actions:0})),metrics:factionRecord(state.config.factionIds,emptyMetrics),workers:[]}};
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',s=>s.send(JSON.stringify(snapshot)));
 await page.route('**/comparison/aurora',r=>r.fulfill({json:{forecast:{horizons:[{days:720},{days:1440}]},institutions:{route:'utopia'},industry:[{reservedJobs:2}]}}));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await expect(page.locator('.institutions')).toHaveCount(4);const first=page.locator('.institutions').first();await expect(first).toContainText('乌托邦共同体');await expect(first).toContainText('电 50.0 / 矿 30.0 / 粮 50.0');
 await first.getByText('乌托邦资格与灯塔',{exact:true}).click();await expect(first).toContainText('参战本身不使评估失格');
 await first.getByText('统一决策比较与720／1440日预测',{exact:true}).click();await expect(first.locator('pre')).toContainText('reservedJobs');
 await page.screenshot({path:'.data/verification/v5-institutions.png',fullPage:true});
 await page.getByLabel('观察势力').selectOption('umbra');await expect(page.locator('.institutions')).toHaveCount(1);await expect(page.locator('.institutions')).not.toContainText('乌托邦共同体');expect(errors).toEqual([]);
});
test('V5比较只读、导出与空闲收尾保存顺序',async({page})=>{
 const response=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted'}});expect(response.ok()).toBe(true);const initial=await response.json();expect(initial.state.version).toBe(5);
 const comparison=await page.request.get(`/api/matches/${initial.state.id}/rounds/0/comparison/aurora`);expect(comparison.ok()).toBe(true);expect((await comparison.json()).institutions.route.choice).toBe('secular');
 expect((await(await page.request.get('/api/state')).json()).state).toEqual(initial.state);
 await page.goto('/');await page.getByLabel('观察势力').selectOption('aurora');
 const card=page.locator('.institutions');await card.getByText('统一决策比较与720／1440日预测',{exact:true}).click();
 await expect(card.getByText('资源用途与加工瓶颈',{exact:true})).toBeVisible();
 await expect(card.getByText('文明路线：当前收益与可执行准备',{exact:true})).toBeVisible();
 await expect(card.getByText('已知施工条件与探索',{exact:true})).toBeVisible();
 await page.screenshot({path:'.data/verification/v51-comparison.png',fullPage:true});
 await page.request.post('/api/step');await expect.poll(async()=>{const s=await(await page.request.get('/api/state')).json();return !s.status.busy&&s.state.round===1;}).toBe(true);
 // No arbitrary delay: idle means audit and checkpoint have completed.
 expect((await page.request.post('/api/save')).ok()).toBe(true);expect((await page.request.post('/api/step')).ok()).toBe(true);
 await expect.poll(async()=>{const s=await(await page.request.get('/api/state')).json();return !s.status.busy&&s.state.round===2;}).toBe(true);
 const audit=await page.request.get(`/api/matches/${initial.state.id}/export/jsonl`);expect(await audit.text()).toContain('welfare');
 const chronicle=await page.request.get(`/api/matches/${initial.state.id}/export/markdown`);expect(await chronicle.text()).toContain('永久文明路线与民众待遇');
});
