import {test,expect} from '@playwright/test';
import {createGame} from '../../src/sim/world.js';
import {DEFAULT_CONFIG,factionRecord} from '../../src/shared/rules.js';
import {emptyMetrics} from '../../src/sim/bot.js';
import {applyAction} from '../../src/sim/actions.js';
import {advanceRound} from '../../src/sim/engine.js';
import {SimulationPool} from '../../src/sim/pool.js';
import {relationship} from '../../src/shared/diplomacy.js';
import {decisionComparison} from '../../src/sim/options.js';

test('5.4什四税、公开通牒、收支分账与受限视角',async({page})=>{
 let state=createGame({...structuredClone(DEFAULT_CONFIG),controller:'scripted'},'browser-v54');
 const f=state.factions.umbra;f.civilization={choice:'theocracy',establishedDay:0};f.welfare!.choice='church';f.unity=0;
 f.faith={name:'什四税测试国教',doctrine:'明确测试状态',establishedDay:0,crisis:100,sites:[],lossWindow:0,lossUsed:0,pending:[],triggers:{}};
 state.factions.aurora.civilization={choice:'utopia',establishedDay:0};state.factions.aurora.welfare!.choice='utopian';
 const relation=relationship(state,'aurora','umbra')!;relation.status='peace';relation.confirmed=['aurora','umbra'];
 applyAction(state,'umbra',{type:'activate_extraction',args:{}},'browser');
 applyAction(state,'aurora',{type:'demand_stop_extraction',args:{factionId:'umbra',eventId:f.extraction!.id}},'browser-demand');
 const pool=new SimulationPool(0);try{state=await advanceRound(state,pool);}finally{await pool.close();}
 const snapshot={state,lastDecisions:null,status:{phase:'paused',running:false,busy:false,error:null,ai:factionRecord(state.config.factionIds,()=>({status:'等待',requests:0,actions:0})),metrics:factionRecord(state.config.factionIds,emptyMetrics),workers:[]}};
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',s=>s.send(JSON.stringify(snapshot)));
 await page.route('**/comparison/*',r=>r.fulfill({json:decisionComparison(state,r.request().url().split('/').at(-1)!)}));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await expect(page.locator('.emergency-panel').filter({hasText:'特殊补助（无资源来源）'}).first()).toBeVisible();
 await expect(page.locator('.emergency-panel').first()).toContainText('无条件停战不会强制停止征收');
 await page.getByLabel('观察势力').selectOption('aurora');
 const panels=page.locator('.emergency-panel');await expect(panels.first()).toContainText('extraction-browser');
 await expect(page.getByText('特殊补助（无资源来源）',{exact:true})).toHaveCount(0);
 await page.getByLabel('观察势力').selectOption('umbra');await expect(page.getByText('特殊补助（无资源来源）',{exact:true}).first()).toBeVisible();
 await page.screenshot({path:'.data/verification/v54/emergency-ui.png',fullPage:true});expect(errors).toEqual([]);
});

test('5.4默认配置、只读对照、暂停分支和编年史导出',async({request})=>{
 const initial=await(await request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted'}})).json();
 expect(initial.state.rulesRevision).toBe('5.4');
 const rules=await(await request.get('/api/rules')).json();expect(rules.emergency.duration).toBe(1800);expect(rules.rules.maxActions).toBe(48);
 const comparison=await(await request.get(`/api/matches/${initial.state.id}/rounds/0/comparison/aurora`)).json();expect(comparison.emergencyEconomy).toHaveProperty('withoutSubsidy');expect(comparison.responsibilities.emergency.available).toBe(false);
 expect((await(await request.get('/api/state')).json()).state).toEqual(initial.state);
 const audit=await(await request.get(`/api/matches/${initial.state.id}/export/jsonl`)).text();expect(audit).toContain('governanceCap');
 const branch=await(await request.post('/api/load',{data:{id:initial.state.id,rulesRevision:'5.4'}})).json();expect(branch.state.id).not.toBe(initial.state.id);expect(branch.status.running).toBe(false);expect(branch.status.phase).toBe('paused');
 const markdown=await(await request.get(`/api/matches/${branch.state.id}/export/markdown`)).text();expect(markdown).toContain('5.4');
});
