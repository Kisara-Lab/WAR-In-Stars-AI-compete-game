import { expect, test } from '@playwright/test';
import { DEFAULT_CONFIG, FACTION_PRESETS, factionRecord } from '../../src/shared/rules.js';
import { createGame as createLatestGame } from '../../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { emptyMetrics } from '../../src/sim/bot.js';
import { refreshIntel } from '../../src/sim/intel.js';

for (const count of [4,8]) test(`4.3 ${count}方岗位、产业链、队列、储备分和受限视角`,async({page})=>{
 const ids=FACTION_PRESETS.slice(0,count).map(f=>f.id);
 const state=createGame({...structuredClone(DEFAULT_CONFIG),factionIds:ids,systemCount:count*6,models:factionRecord(ids,()=> 'test')},'browser-industry-'+count);
 const p=state.systems[0].planets[0];p.population=2;p.expansions={ground:2,orbital:true};p.structures.push({id:'sealed',type:'hospital',sealed:true});
 state.systems[0].projects.push({id:'expand',kind:'expansion',expansion:'ground1',planetId:p.id,ownerId:'aurora',structureType:null,shipType:null,progress:100000,requiredDays:300,cost:{energy:0,food:0,minerals:300000,alloys:0},createdDay:0});
 refreshIntel(state);
 const snapshot={state,lastDecisions:null,status:{phase:'paused',running:false,busy:false,error:null,ai:factionRecord(ids,()=>({status:'等待',requests:0,actions:0})),metrics:factionRecord(ids,emptyMetrics),workers:[]}};
 await page.route('**/api/state',route=>route.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify(snapshot)));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await expect(page.locator('.industry-summary')).toHaveCount(count);
 await expect(page.locator('.industry-summary').first()).toContainText('合金 100.0');
 await page.locator('.industry-planet').first().locator('summary').click();
 await expect(page.locator('.industry-planet').first()).toContainText('缺员');
 await expect(page.locator('.industry-planet').first()).toContainText('封存');
 await expect(page.locator('.industry-planet').first()).toContainText('扩槽');
 await expect(page.locator('.system-panel')).toContainText('/ 12');
 await expect(page.locator('.system-panel')).toContainText('/ 8');
 await page.screenshot({path:'.data/verification/industry-'+count+'.png',fullPage:true});
 await page.getByLabel('观察势力').selectOption('umbra');
 await expect(page.locator('.industry-summary')).toHaveCount(1);
 await expect(page.locator('.system-panel .industry-planet')).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('V5默认新局脚本单轮审计及编年史导出，恢复保持修订',async({page})=>{
 const created=await(await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted'}})).json();
 expect(created.state.rulesRevision).toBe('5.4');
 const step=await page.request.post('/api/step');expect(step.ok()).toBe(true);
 await expect.poll(async()=> (await(await page.request.get('/api/state')).json()).state.round).toBe(1);
 const snapshot=await(await page.request.get('/api/state')).json();
 const journal=await page.request.get(`/api/matches/${snapshot.state.id}/export/jsonl`);
 expect(journal.ok()).toBeTruthy();expect(await journal.text()).toContain('processing');
 const chronicle=await page.request.get(`/api/matches/${snapshot.state.id}/export/markdown`);
 expect(chronicle.ok()).toBeTruthy();expect(await chronicle.text()).toContain('人口岗位与产业转型');
 const loaded=await(await page.request.post('/api/load',{data:{id:snapshot.state.id}})).json();expect(loaded.state.rulesRevision).toBe('5.4');expect(loaded.status.phase).toBe('paused');
});
