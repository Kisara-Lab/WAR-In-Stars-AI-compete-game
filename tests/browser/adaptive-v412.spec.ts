import {test,expect} from '@playwright/test';
import {DEFAULT_CONFIG} from '../../src/shared/rules.js';
test('V4.12 default, cause diagnostics, campaign roles and exact submitted certificate',async({page})=>{
  test.setTimeout(60000);
  const response=await page.request.post('/api/matches',{data:{...DEFAULT_CONFIG,controller:'scripted',computeWorkers:0,planningCacheMiB:0,maxRounds:3}});
  expect(response.ok()).toBe(true);
  const created=await response.json();expect(created.state.config.scriptStrategy).toBe('adaptive-v4.12');expect(created.status.running).toBe(false);
  await page.goto('/');await page.getByRole('button',{name:'▷ 单轮推进'}).click();
  await expect(page.locator('.match-clock strong')).toHaveText('001',{timeout:45000});
  const panel=page.getByRole('region',{name:'智能脚本规划'});
  await panel.locator(':scope > details').first().locator('summary').first().click();
  await expect(panel).toContainText('V4.12：持续国家计划、主力与二次支援');await expect(panel).toContainText('实际提交');await expect(panel).toContainText('资金欠付、交付阻断与责任诊断');
  await expect(panel).toContainText('殖民链、储资与战争机会成本');
  await expect(panel).toContainText('殖民与军备生产账：资金、到达时间和防御缺口');
  const saved=await(await page.request.get('/api/state')).json();
  for(const decision of Object.values(saved.lastDecisions) as any[]){expect(decision.scriptReport.turn.actions).toBe(decision.actions.length);expect(decision.scriptReport.v412.finalCertificate).toBeTruthy();expect(decision.metrics.requests).toBe(0);}
  await page.screenshot({path:(process.env.V412_BROWSER_DATA??'.data/verification/adaptive-v412/development-browser')+'-panel.png',fullPage:true});
  await page.getByRole('button',{name:'＋ 新比赛'}).click();
  await expect(page.getByLabel('脚本策略')).toHaveValue('adaptive-v4.12');
  await expect(page.getByLabel('搜索档位')).toHaveValue('standard');
});
