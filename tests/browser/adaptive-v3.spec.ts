import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';

test('V3 profiles, compute settings, combinations and governance',async({page})=>{
  test.setTimeout(60000);
  const created=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',scriptStrategy:'adaptive-v3',scriptSearchProfile:'standard',computeWorkers:0,planningCacheMiB:0,maxRounds:3}});
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button',{name:'＋ 新比赛'}).click();
  await expect(page.getByLabel('搜索档位')).toHaveValue('standard');
  await page.getByLabel('搜索档位').selectOption('deep');
  await expect(page.getByLabel('计算线程')).toBeVisible();
  await expect(page.getByLabel('规划缓存')).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'▷ 单轮推进'}).click();
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:30000});
  const panel=page.getByRole('region',{name:'智能脚本规划'});
  await panel.locator(':scope > details').first().locator('summary').first().click();
  await expect(panel).toContainText('组合搜索');await expect(panel).toContainText('治理及责任情景');
  await expect(panel).toContainText('整轮行动');await expect(panel).toContainText('停手原因');await expect(panel).toContainText('福利持续性校验');
  const snapshot=await(await page.request.get('/api/state')).json();
  expect(snapshot.state.config.scriptSearchProfile).toBe('standard');
  expect(snapshot.state.config.computeWorkers).toBeUndefined();
  expect(snapshot.status.metrics.aurora.requests).toBe(0);
});
