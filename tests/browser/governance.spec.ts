import { expect,test } from '@playwright/test';
import { DEFAULT_CONFIG,factionRecord } from '../../src/shared/rules.js';
import { createGame } from '../../src/sim/world.js';
import { emptyMetrics } from '../../src/sim/bot.js';
import { recordGovernance } from '../../src/shared/governance.js';
import { welfareQuote } from '../../src/shared/civilization.js';
import { createWar } from '../../src/sim/wars.js';
test('5.3治理、停战、并行与受限视角',async({page})=>{
 const state=createGame({...DEFAULT_CONFIG,controller:'scripted'},'browser-governance','5.3');
 const f=state.factions.aurora;f.unity=6000;state.day=10;const q=welfareQuote(state,'aurora',10);f.welfare!.last={...q,day:10,paid:q.deliverable,fraction:1,reasons:[]};recordGovernance(state);
 const home=state.systems[0],p=home.planets[0];p.structures.push({id:'dock',type:'drydock'});p.population=24;
 const target=state.systems.find(s=>s.ownerId==='umbra')!,war=createWar(state,['aurora','umbra'],'limited');war.goals.aurora=[{systemId:target.id,type:'limited',heldDays:140}];target.controllerId='aurora';target.occupationWarId=war.id;
 const snapshot={state,lastDecisions:null,status:{phase:'paused',running:false,busy:false,error:null,ai:factionRecord(state.config.factionIds,()=>({status:'等待',requests:0,actions:0})),metrics:factionRecord(state.config.factionIds,emptyMetrics),workers:[]}};
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',s=>s.send(JSON.stringify(snapshot)));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await page.locator('.score-detail summary').first().click();await expect(page.locator('.governance-detail').first()).toContainText('80.000%');await expect(page.locator('.governance-detail').first()).toContainText('10/720');
 await page.getByText('停战结算预览',{exact:true}).click();await expect(page.locator('.civilization-panel')).toContainText('无条件停战归还');await expect(page.locator('.civilization-panel')).toContainText('当前未达标');
 await page.getByRole('button',{name:'◎ 单星系'}).click();await page.locator('.industry-planet summary').first().click();await expect(page.locator('.industry-planet').first()).toContainText('造船2条');
 await page.getByLabel('观察势力').selectOption('aurora');await expect(page.locator('.governance-detail')).toHaveCount(1);
 await page.screenshot({path:'.data/verification/v53/governance-ui.png',fullPage:true});expect(errors).toEqual([]);
});
test('5.3规则配置、只读比较及导出',async({request})=>{
 const response=await request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted'}}),initial=await response.json();expect(initial.state.rulesRevision).toBe('5.4');
 const comparison=await(await request.get(`/api/matches/${initial.state.id}/rounds/0/comparison/aurora`)).json();expect(comparison.actionLimit).toBe(48);expect(comparison.governance.estimated).toBe(true);
 expect((await(await request.get('/api/state')).json()).state).toEqual(initial.state);
 const audit=await(await request.get(`/api/matches/${initial.state.id}/export/jsonl`)).text();expect(audit).toContain('annexationBufferCap');
 const markdown=await(await request.get(`/api/matches/${initial.state.id}/export/markdown`)).text();expect(markdown).toContain('governance');
});
