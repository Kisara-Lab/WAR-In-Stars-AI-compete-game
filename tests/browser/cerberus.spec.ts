import { test, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules.js';

test('Cerberus exposes actual execution separately from submitted plans', async ({ page }) => {
  const response = await page.request.post('/api/matches', { data: { ...DEFAULT_CONFIG, controller: 'scripted', scriptStrategy: 'sras-v1.3cerberus', planningWorkers: 0, forecastWorkers: 0 } });
  expect(response.ok()).toBe(true);
  expect((await page.request.post('/api/step')).ok()).toBe(true);
  await expect.poll(async () => {
    const snapshot = await (await page.request.get('/api/state')).json();
    if (snapshot.status.error) throw new Error(snapshot.status.error);
    return snapshot.state.round;
  }, { timeout: 60000 }).toBe(1);
  await page.goto('/');
  await expect(page.locator('.script-strategy')).toContainText('rules-1.3-cerberus-3');
  await expect(page.locator('.script-strategy')).toContainText('指令意图数');
  const snapshot = await (await page.request.get('/api/state')).json();
  for (const decision of Object.values(snapshot.lastDecisions) as any[]) {
    expect(decision.metrics.requests).toBe(0);
    expect(decision.scriptReport.cerberus.quality.submitted).toBe(decision.actions.length);
    expect(decision.scriptReport.cerberus.quality.executed).toBe(decision.scriptReport.cerberus.execution.accepted);
  }
});
