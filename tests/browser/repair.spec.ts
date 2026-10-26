import { expect, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { DEFAULT_CONFIG, factionIds, factionRecord } from '../../src/shared/rules.js';
import type { LiveSnapshot } from '../../src/shared/types.js';
import { createGame as createLatestGame } from '../../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { emptyMetrics } from '../../src/sim/bot.js';

test('SSE进度、回合内纠错、回滚和接受结果明确区分', async ({ page }) => {
  const state = createGame(structuredClone(DEFAULT_CONFIG), 'browser-repair');
  const ids = factionIds(state);
  const snapshot: LiveSnapshot = { state, lastDecisions: null, status: { phase: 'deciding', running: true, busy: true, error: null, ai: factionRecord(ids, () => ({ status: 'SSE 接收中 · 请求 1/3 · 12 事件', requests: 1, actions: 0 })), metrics: factionRecord(ids, emptyMetrics), workers: [] } };
  let socket: WebSocketRoute;
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/ws', route => { socket = route; route.send(JSON.stringify(snapshot)); });
  await page.route('**/api/matches/browser-repair/audit?*', route => route.fulfill({ json: { coverage: '隔离浏览器验证', total: 1, matched: 1, next: null, records: [{ seq: 1, round: 1, day: 0, time: '2026-10-23', category: 'model.tool', factionId: 'aurora', committed: true, hash: 'test', data: { result: { ok: false, disposition: 'rolled_back' } } }] } }));
  await page.goto('/');
  await expect(page.locator('.ai-state').first()).toContainText('SSE 接收中');
  snapshot.status.ai.aurora.status = '正在纠错 · 已用 1/3 次请求';
  socket!.send(JSON.stringify(snapshot));
  await expect(page.locator('.ai-state').first()).toContainText('正在纠错');
  snapshot.status.phase = 'paused'; snapshot.status.running = false; snapshot.status.busy = false;
  snapshot.status.ai.aurora.status = '计划已接受，等待共同结算';
  snapshot.lastDecisions = factionRecord(ids, () => ({ actions: [], summary: '公开计划，不是事实', metrics: { ...emptyMetrics(), requests: 2 }, trace: [
    { name: 'queue_ships', args: {}, ok: true, message: '校验成功后整批回滚', batchId: 'batch-first', disposition: 'rolled_back' },
    { name: 'declare_war', args: { systemIds: ['s1'] }, ok: false, message: 'TOTAL_WAR_TARGETS_MUST_BE_EMPTY', batchId: 'batch-first', disposition: 'rejected' },
    { name: 'declare_war', args: { systemIds: [] }, ok: true, message: '总体战校验通过', batchId: 'batch-second', disposition: 'accepted' },
  ] }));
  socket!.send(JSON.stringify(snapshot));
  await page.getByRole('button', { name: 'AI 决策记录', exact: true }).click();
  const column = page.locator('.decision-column').first();
  await expect(column).toContainText('2 次请求');
  await expect(column).toContainText('整批已回滚');
  await expect(column).toContainText('校验接受，非执行证明');
  await expect(column).toContainText('是否执行以事件及结算记录为准');
  await column.locator('.tool-trace').first().locator('summary').click();
  await expect(column).toContainText('batch-first');
  await page.screenshot({ path: '.data/verification/sse-repair-browser.png', fullPage: true });
  await page.getByRole('button', { name: '完整审计日志', exact: true }).click();
  await page.getByLabel('审计类别').selectOption('model.stream');
  await expect(page.getByLabel('审计类别')).toHaveValue('model.stream');
  await page.locator('.audit-record summary').click();
  await expect(page.locator('.audit-record')).toContainText('所属回合已提交');
  await expect(page.locator('.audit-record')).toContainText('不代表每条命令都执行');
});
