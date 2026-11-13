import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';
import {availableParallelism} from 'node:os';

test('V2规划线程、建筑位置、受限比较和导出',async({page})=>{
  test.setTimeout(60000);
  const budget=Math.max(0,Math.min(16,availableParallelism()-2)),planningWorkers=Math.min(2,budget),forecastWorkers=Math.min(2,budget-planningWorkers);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const created=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v2',maxRounds:3,planningWorkers,forecastWorkers}});
  expect(created.ok()).toBe(true);
  await page.goto('/');await page.getByRole('button',{name:'▷ 单轮推进'}).click();
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:30000});
  await expect(page.locator('.statusbar')).toContainText(`规划 ${planningWorkers} / 预测 ${forecastWorkers}`);
  const panel=page.getByRole('region',{name:'智能脚本规划'});await expect(panel).toContainText('adaptive-v2');
  await panel.locator('details').first().locator('summary').first().click();
  await expect(panel).toContainText('文明、战争路径与传感覆盖比较');
  await page.getByLabel('观察势力').selectOption('aurora');
  await expect(panel.locator(':scope > details')).toHaveCount(1);
  const planet=page.locator('.industry-planet').first();await planet.locator('summary').first().click();
  await expect(planet).toContainText('预留');await expect(planet).toContainText('轨道');await expect(planet).toContainText('地表');
  const snapshot=await(await page.request.get('/api/state')).json();
  expect(snapshot.state.config.planningWorkers).toBeUndefined();expect(snapshot.status.metrics.aurora.requests).toBe(0);
  const exported=await page.request.get(`/api/matches/${snapshot.state.id}/export/markdown`);expect(await exported.text()).toContain('adaptive-v2');
  expect(errors).toEqual([]);
});
