import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';

test('formal strategy defaults and actual responsibility report',async({page})=>{
  test.setTimeout(60000);
  const response=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',computeWorkers:0,planningCacheMiB:0,maxRounds:120}});
  expect(response.ok()).toBe(true);
  const created=await response.json();
  expect(created.state.config.scriptStrategy).toBe('adaptive-v4.15-final');
  expect(created.status.running).toBe(false);
  await page.goto('/');
  await page.request.post('/api/step');
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:45000});
  const panel=page.getByRole('region',{name:'智能脚本规划'});
  await panel.locator(':scope > details').first().locator('summary').first().click();
  await expect(panel).toContainText('共享开发账与持续任务');
  await expect(panel).toContainText('responsibility');
  const saved=await(await page.request.get('/api/state')).json();
  for(const decision of Object.values(saved.lastDecisions) as any[]){
    expect(decision.scriptReport.turn.actions).toBe(decision.actions.length);
    expect(decision.scriptReport.v415final.finalCertificate).toBeTruthy();
    expect(decision.metrics.requests).toBe(0);
  }
  await page.getByRole('button',{name:'＋ 新比赛'}).click();
  await expect(page.getByLabel('脚本策略')).toHaveValue('adaptive-v4.15-final');
  await expect(page.getByLabel('搜索档位')).toHaveValue('standard');
});

