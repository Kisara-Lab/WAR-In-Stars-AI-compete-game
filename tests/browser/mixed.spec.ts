import { test, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules.js';

test('mixed seats, script settings, paused creation and faction labels', async ({ page }) => {
  await page.route('**/api/provider', route => route.fulfill({ json: { configured: true, host: 'mock.invalid', models: ['grok-4.7', 'mock-model'] } }));
  const initial = await page.request.post('/api/matches', { data: { ...DEFAULT_CONFIG, controller: 'scripted', scriptStrategy: 'legacy' } });
  expect(initial.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 新比赛' }).click();
  await page.getByLabel('控制方式').selectOption('mixed');
  await expect(page.getByLabel('晨曦共同体 控制器')).toHaveValue('model');
  await expect(page.getByLabel('暮影议会 控制器')).toHaveValue('scripted');
  await expect(page.getByLabel('搜索档位')).toHaveValue('standard');
  await page.getByLabel('晨曦共同体 模型').selectOption('mock-model');
  await page.getByLabel('势力数量').selectOption('6');
  await expect(page.getByLabel('绯红帝国 控制器')).toHaveValue('model');
  await expect(page.getByLabel('金曜公社 控制器')).toHaveValue('scripted');
  await page.getByLabel('势力数量').selectOption('4');
  await expect(page.getByLabel('晨曦共同体 模型')).toHaveValue('mock-model');
  await page.getByLabel('晨曦共同体 控制器').selectOption('scripted');
  await page.getByLabel('翠星联邦 控制器').selectOption('scripted');
  await expect(page.getByRole('button', { name: '创建比赛', exact: true })).toBeDisabled();
  await page.getByLabel('晨曦共同体 控制器').selectOption('model');
  await page.getByLabel('翠星联邦 控制器').selectOption('model');
  await page.getByLabel('计算线程', { exact: true }).fill('0');
  await page.getByRole('button', { name: '创建比赛', exact: true }).click();
  await expect(page.locator('.control-mode')).toHaveText('AI VS 智能脚本');
  const snapshot = await (await page.request.get('/api/state')).json();
  expect(snapshot.state.config.controller).toBe('mixed');
  expect(Object.keys(snapshot.state.config.models).sort()).toEqual(['aurora', 'verdant']);
  expect(snapshot.state.round).toBe(0);
  expect(snapshot.status.running).toBe(false);
  expect(snapshot.status.metrics.aurora.requests).toBe(0);
  await expect(page.locator('.model-tag').filter({ hasText: '智能脚本 · adaptive-v4' })).toHaveCount(2);
  const panel = page.getByRole('region', { name: '智能脚本规划' });
  await expect(panel.locator(':scope > details')).toHaveCount(2);
  await expect(panel).toContainText('脚本方模型请求与 token 为 0');
});

test('mixed creation is disabled without a provider', async ({ page }) => {
  await page.route('**/api/provider', route => route.fulfill({ json: { configured: false, models: ['grok-4.7'] } }));
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 新比赛' }).click();
  await page.getByLabel('控制方式').selectOption('mixed');
  await expect(page.getByRole('button', { name: '创建比赛', exact: true })).toBeDisabled();
  await expect(page.getByText('仅模型席位使用接口额度', { exact: false })).toBeVisible();
});
