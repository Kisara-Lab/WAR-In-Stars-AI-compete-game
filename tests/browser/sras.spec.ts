import { test,expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules.js';
test('explicit SRAS entry clears search, creates paused, and shows rule reports with zero cost',async({page})=>{
  const response=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'sras-v1.1',planningWorkers:0,forecastWorkers:0}});expect(response.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button',{name:'＋ 新比赛'}).click();
  await page.getByLabel('控制方式').selectOption('scripted');
  const strategy=page.locator('select').filter({has:page.locator('option[value="sras-v1.1"]')});
  await strategy.selectOption('sras-v1.1');await expect(page.getByLabel('搜索档位')).toHaveCount(0);
  await page.getByRole('button',{name:'创建比赛',exact:true}).click();
  const state=await(await page.request.get('/api/state')).json();expect(state.status.running).toBe(false);expect(state.state.config.scriptSearchProfile).toBeUndefined();
  expect((await page.request.post('/api/step')).ok()).toBe(true);
  await expect.poll(async()=>{const s=await(await page.request.get('/api/state')).json();if(s.status.error)throw new Error(s.status.error);return s.state.round;},{timeout:60000}).toBe(1);
  await page.reload();await expect(page.locator('.script-strategy')).toContainText('SRAS');
  const result=await(await page.request.get('/api/state')).json();for(const d of Object.values(result.lastDecisions) as any[]){expect(d.scriptReport.version).toBe('sras-v1.1');expect(d.metrics.requests).toBe(0);expect(d.scriptReport.forecasts).toBe(0);}
});
