import { V54 } from '../shared/emergency.js';
import { V53, actionLimit, outputLimit } from '../shared/governance.js';
import { RESPONSIBILITY } from '../shared/responsibility.js';
import { decisionComparison } from '../sim/options.js';
import { CIVILIZATION, WELFARE, DECISION_BALANCE, welfareRules, V5_POLICIES } from '../shared/civilization.js';
import { ESCALATION } from '../shared/escalation.js';
import { V4, WAR_NAMES } from '../shared/v4.js';
import { POLICIES } from '../shared/civil.js';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { INDUSTRY, BUILDING_EFFECTS, LABOR, EXPANSIONS } from '../shared/industry.js';
import { BASE, DEFAULT_CONFIG, RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import { maxWorkers } from '../sim/pool.js';
import type { MatchRunner } from './runner.js';
import type { ModelProvider } from './provider.js';

const modelName = z.string().min(1).max(160);
const matchSchema = z.strictObject({
  seed: z.string().min(1).max(100),
  factionIds: z.array(z.string().min(1).max(40)).min(4).max(8),
  systemCount: z.number().int().min(24).max(512),
  maxRounds: z.number().int().min(1).max(1000),
  models: z.record(z.string(), modelName),
  controller: z.enum(['model', 'scripted']),
  workers: z.number().int().min(1).max(maxWorkers()).optional(),
});

function originAllowed(origin: string | undefined) {
  if (!origin) return true;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); } catch { return false; }
}

export function createApplication(runner: MatchRunner, providerFactory: () => Promise<ModelProvider>, projectRoot: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    if (!originAllowed(request.headers.origin)) { response.status(403).json({ error: '仅允许本机观察界面访问' }); return; }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_request, response) => { response.json({ ok: true, workers: runner.pool.size, maxWorkers: maxWorkers() }); });
  app.get('/api/state', (_request, response) => { response.json(runner.snapshot()); });
  app.get('/api/rules', (_request, response) => { response.json({ civilization: {...CIVILIZATION, revision: V54.revision}, welfare: welfareRules({rulesRevision:V54.revision}), decisionBalance: DECISION_BALANCE, responsibilities: RESPONSIBILITY, modernPolicies: V5_POLICIES, industry: INDUSTRY, effects: BUILDING_EFFECTS, labor: LABOR, expansions: EXPANSIONS, emergency: V54, governance: V53, defaults: DEFAULT_CONFIG, rules: {...RULES,maxActions:actionLimit({rulesRevision:V54.revision}),maxOutputTokens:outputLimit({rulesRevision:V54.revision})}, v4: V4, escalation: ESCALATION, warTypes: WAR_NAMES, structures: STRUCTURES, policies: POLICIES, ships: SHIPS, base: BASE }); });
  app.get('/api/provider', async (_request, response) => {
    try {
      const provider = await providerFactory();
      try { response.json({ configured: true, protocol: 'responses', host: new URL(provider.config.base).host, models: await provider.models() }); }
      catch (error) { response.json({ configured: true, protocol: 'responses', host: new URL(provider.config.base).host, models: ['grok-4.5', 'grok-4.6', 'grok-4.7'], error: error instanceof Error ? error.message : '模型列表暂不可用' }); }
    } catch { response.json({ configured: false, protocol: 'responses', models: ['grok-4.7'], error: '请在项目目录的 AIKEY.env 中配置 base 和 key' }); }
  });
  app.post('/api/matches', async (request, response) => {
    const { workers, ...config } = matchSchema.parse(request.body);
    if (config.factionIds.some(id => !config.models[id]) || Object.keys(config.models).some(id => !config.factionIds.includes(id))) throw new Error('模型配置必须与势力清单一致');
    await runner.create(config, workers); response.json(runner.snapshot());
  });
  app.post('/api/start', (_request, response) => { runner.start(); response.json({ ok: true }); });
  app.post('/api/step', (_request, response) => { runner.start(true); response.json({ ok: true }); });
  app.post('/api/pause', (_request, response) => { runner.pause(); response.json({ ok: true }); });
  app.post('/api/save', async (_request, response) => { response.json(await runner.save()); });
  app.get('/api/matches', async (_request, response) => { response.json(await runner.store.list()); });
  app.get('/api/matches/:id/rounds/:round', async (request, response) => {
    const round = z.coerce.number().int().min(0).max(1000).parse(request.params.round);
    response.json(await runner.store.load(request.params.id, round));
  });
  app.get('/api/matches/:id/rounds/:round/comparison/:actor',async(request,response)=>{
    const checkpoint=await runner.store.load(request.params.id,z.coerce.number().int().min(0).parse(request.params.round));
    if(!checkpoint.state.factions[request.params.actor]) throw new Error('未知势力');
    response.json(decisionComparison(checkpoint.state,request.params.actor));
  });
  app.post('/api/load', async (request, response) => {
    const body = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), round: z.number().int().min(0).max(1000).optional(), rulesRevision: z.enum(['4.2', '4.3', '5.0', '5.1', '5.2', '5.3', '5.4']).optional() }).parse(request.body);
    await runner.load(body.id, body.round, body.rulesRevision); response.json(runner.snapshot());
  });
  app.get('/api/matches/:id/audit', async (request, response) => {
    const filter = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), factionId: z.string().optional(), systemId: z.string().optional(), category: z.string().optional(), attemptId: z.string().optional(), fromDay: z.coerce.number().min(0).optional(), toDay: z.coerce.number().min(0).optional() }).parse(request.query);
    response.json(await runner.store.queryAudit(request.params.id, filter));
  });
  app.get('/api/matches/:id/export/:format', async (request, response) => {
    const format = z.enum(['markdown', 'jsonl']).parse(request.params.format);
    const body = format === 'markdown' ? await runner.store.exportChronicle(request.params.id) : await runner.store.exportAudit(request.params.id);
    response.setHeader('Content-Disposition', `attachment; filename="${request.params.id}.${format === 'markdown' ? 'md' : 'jsonl'}"`);
    response.type(format === 'markdown' ? 'text/markdown' : 'application/x-ndjson').send(body);
  });
  app.use('/api', (_request, response) => { response.status(404).json({ error: '接口不存在' }); });
  const clientDirectory = join(projectRoot, 'dist', 'client');
  if (existsSync(join(clientDirectory, 'index.html'))) {
    app.use(express.static(clientDirectory, { index: false }));
    app.get('/{*path}', (_request, response) => { response.sendFile(join(clientDirectory, 'index.html')); });
  } else app.get('/', (_request, response) => { response.type('text').send('开发界面：http://127.0.0.1:5173；生产模式请先运行 npm run build。'); });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : '请求失败';
    response.status(error instanceof z.ZodError ? 400 : 409).json({ error: message });
  });
  const server = createServer(app);
  const sockets = new WebSocketServer({ server, path: '/ws', verifyClient: (info: { origin: string }) => originAllowed(info.origin) });
  const send = (socket: WebSocket) => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(JSON.stringify(runner.snapshot())); };
  sockets.on('connection', socket => { socket.on('error', () => {}); send(socket); });
  let queued = false;
  const unsubscribe = runner.subscribe(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; for (const socket of sockets.clients) send(socket); }, 50).unref();
  });
  server.on('close', unsubscribe);
  return { app, server, sockets };
}
