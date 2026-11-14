import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';

test('V4 recovery, budgets and tactical evidence panel',async({page})=>{
  test.setTimeout(60000);
  const created=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v4',scriptSearchProfile:'standard',computeWorkers:0,planningCacheMiB:0,maxRounds:3}});
  expect(created.ok()).toBe(true);
  await page.goto('/');await page.getByRole('button',{name:'▷ 单轮推进'}).click();
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:45000});
  const panel=page.getByRole('region',{name:'智能脚本规划'});
  await panel.locator(':scope > details').first().locator('summary').first().click();
  await expect(panel).toContainText('V4：危机恢复与争胜决策');
  await expect(panel).toContainText('预计供应恢复日');
  await expect(panel).toContainText('兵力、双方战损、预计得分与未执行原因');
  await expect(panel).toContainText('停手原因');
  const state=await(await page.request.get('/api/state')).json();
  expect(state.lastDecisions.aurora.scriptReport.version).toBe('adaptive-v4');
  expect(state.status.metrics.aurora.requests).toBe(0);
});
