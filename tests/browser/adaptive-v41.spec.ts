import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';
test('V4.1 creation, controller labels and final certificate match accepted actions',async({page})=>{
  test.setTimeout(60000);
  const response=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v4.1',computeWorkers:0,planningCacheMiB:0,maxRounds:3}});
  expect(response.ok()).toBe(true);
  const created=await response.json();expect(created.state.config.scriptStrategy).toBe('adaptive-v4.1');expect(created.status.running).toBe(false);
  await page.goto('/');await page.getByRole('button',{name:'▷ 单轮推进'}).click();
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:45000});
  const panel=page.getByRole('region',{name:'智能脚本规划'});
  await panel.locator(':scope > details').first().locator('summary').first().click();
  await expect(panel).toContainText('V4.1：规划证书与实际保留');await expect(panel).toContainText('最终提交');await expect(panel).toContainText('停手依据');
  const saved=await(await page.request.get('/api/state')).json();
  for(const decision of Object.values(saved.lastDecisions) as any[]){expect(decision.scriptReport.turn.actions).toBe(decision.actions.length);expect(decision.metrics.requests).toBe(0);}
  await page.getByRole('button',{name:'＋ 新比赛'}).click();
  await expect(page.locator('select').filter({has:page.locator('option[value="adaptive-v4.1"]')})).toHaveValue('adaptive-v4.12');
});
