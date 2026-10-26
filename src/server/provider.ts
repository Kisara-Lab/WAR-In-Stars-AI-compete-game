import { outputLimit } from '../shared/governance.js';
import { compactDecisionInput } from './decision-input.js';
import { decisionRules } from './decision-rules.js';
import { industrial, INDUSTRY, BUILDING_EFFECTS, LABOR, EXPANSIONS, shipMaterials } from '../shared/industry.js';
import { BALANCE, balancedRules } from '../shared/balance.js';
import { readResponseStream, ProviderError } from './sse.js';
import type { ModelResponse, StreamProgress } from './sse.js';
export { ProviderError } from './sse.js';
import { ESCALATION, revised } from '../shared/escalation.js';
import { POLICIES } from '../shared/civil.js';
import { V4, WAR_NAMES } from '../shared/v4.js';
import { registerSecret, sanitize } from './audit.js';
import type { AuditCallback } from './audit.js';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { BASE, RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import type { FactionId } from '../shared/rules.js';
import type { Decision, DecisionMetrics, GameState, ToolTrace } from '../shared/types.js';
import { batchSchema, StagingArea, toolDefinitions } from '../sim/actions.js';
import { emptyMetrics } from '../sim/bot.js';
import { observation } from '../sim/intel.js';

export interface ProviderConfig { base: string; key: string }


export async function readProviderConfig(path = 'AIKEY.env'): Promise<ProviderConfig> {
  const values = parse(await readFile(path, 'utf8'));
  if (!values.base || !values.key) throw new Error('AIKEY.env 必须提供 base 和 key');
  const address = new URL(values.base);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('模型 base 必须是无凭据、无查询参数的 HTTP(S) 地址');
  const pathname = address.pathname.replace(/\/+$/, '');
  address.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  registerSecret(values.key);
  return { base: address.href.replace(/\/$/, ''), key: values.key };
}

export function redact(message: string, key: string): string {
  return (key ? message.replaceAll(key, '[密钥已隐藏]') : message).replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]').slice(0, 1200);
}

export class ModelProvider {
  constructor(readonly config: ProviderConfig, private fetcher: typeof fetch = fetch) { registerSecret(config.key); }

  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetcher(`${this.config.base}/models`, { headers: { Authorization: `Bearer ${this.config.key}` }, signal: signal ?? AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ProviderError(`模型列表请求失败：HTTP ${response.status}`);
    const body = await response.json() as { data?: { id: string }[] };
    if (!Array.isArray(body.data)) throw new ProviderError('模型列表响应格式无效');
    return body.data.map(model => model.id).filter(id => typeof id === 'string');
  }

  async respond(body: Record<string, unknown>, signal: AbortSignal, onResponse: (body: unknown, status: number) => Promise<void> = async () => {}, progress: (value: StreamProgress) => Promise<void> = async () => {}): Promise<ModelResponse> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(RULES.requestTimeoutMs)]);
    requestSignal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.base}/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, stream: true }), signal: requestSignal,
      });
    } catch {
      signal.throwIfAborted();
      throw new ProviderError(requestSignal.aborted ? '模型单次请求超过90秒' : '模型网络请求失败', true);
    }
    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = { error: { message: '非JSON错误响应' } }; }
      await onResponse(parsed, response.status);
      throw new ProviderError(redact(`Responses 请求失败：HTTP ${response.status} ${JSON.stringify(parsed)}`, this.config.key), response.status === 429 || response.status >= 500);
    }
    let result: ModelResponse;
    try { result = await readResponseStream(response, requestSignal, progress); }
    catch (error) {
      signal.throwIfAborted();
      if (requestSignal.aborted) throw new ProviderError('模型单次请求超过90秒', true);
      throw error;
    }
    await onResponse(result, response.status);
    return result;
  }

  async decide(state: GameState, factionId: FactionId, signal: AbortSignal, onProgress = (_status: string, _requests: number, _actions: number) => {}, onMetrics = (_metrics: DecisionMetrics) => {}, audit: AuditCallback = async () => {}, recentOutcomes: unknown[] = [], inputMode: 'legacy' | 'balanced' | 'unified' = industrial(state) ? 'unified' : balancedRules(state) ? 'balanced' : 'legacy'): Promise<Decision> {
    const started = performance.now();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(RULES.decisionTimeoutMs)]);
    let staging = new StagingArea(state, factionId);
    const traces: ToolTrace[] = [];
    const metrics: DecisionMetrics = emptyMetrics();
    const facts = { ...observation(state, factionId, null, inputMode !== 'legacy', inputMode === 'unified'), recentDecisionOutcomes: recentOutcomes };
    const input: unknown[] = [{ role: 'user', content: JSON.stringify(inputMode === 'unified' ? compactDecisionInput(facts) : facts) }];
    const seenCalls = new Map<string, unknown>();
    const legacyInstructions = [
      '工具采用整批原子校验：任一命令失败，整批撤销，没有任何资源被预留或命令被接受；根据function_call_output修正后重交完整计划。只能通过submit_turn完成决策，最多3次请求。总体战systemIds必须为[]，目的地用后续move_fleet指定；资格成熟后立即可用，1080日是过期窗口，不是等待时间。recentDecisionOutcomes中的拒绝结果优先于旧摘要；摘要是计划，不等于已执行事实。',
      '你是一场多方AI太空4X比赛的一方指挥官。目标是取得胜利。调用submit_turn，一次提交全部orders和简短中文summary。orders=[]表示等待。完整情报已在输入中，不必再次查询。',
      '这是4～8方比赛，每对势力关系独立。首次发现进入contact；双方confirm_contact后和平且默认闭境。接触期直接交火转战争；和平时必须先declare_war才能攻击。',
      '战争中propose_peace，对方下一轮accept_peace后停战，非总体战归还占领地，总体战保留正式吞并，均签1080日互不侵犯；提议300日过期。条约内禁止宣战，到期仍和平。open_borders/close_borders为单向通行授权，与停战独立。闭境时舰队自动撤离，不要向撤离舰队下令。',
      '外交工具的factionId是目标势力。同轮对同一目标只允许一个关系命令和一个通行命令。先宣战再调动舰队；不要攻击和平势力。get_diplomacy可查询本方关系。',
      '各存活势力同步规划，工具返回的本方资源已经扣除预留，其他势力本轮动作不可见。未探索行星隐藏，过期情报有lastSeenDay。不得假设拥有未知情报。',
      '每轮100日，探索和殖民500日。优先保障电力、食物和矿物，再发展经济、探索扩张和集中军力。基础工期受凝聚力和供应修正。',
      '仅战争或首次接触阶段的敌对双方接近80自动交战；战力强者必胜，败方全毁，胜方承受败方50%等效伤害。同战力全毁。V4区分法理归属与军事控制：非总体战临时占领不吞并；全部法理领土丧失才淘汰。',
      '初始3艘驱逐舰总战力30，低于基地40。舰队星系内移动需要时间，跨航道30日。攻击基地时坐标设为500,500。船厂在行星轨道，造舰后舰队出现在行星位置。',
      revised(state) ? '达到轮数上限后仅使用4.1评分：100*法理星系+200*殖民地+5*人口+0.5*基础舰队战力+矿物/10+去重战争成果。当前实际分项在score中。' : '达到轮数上限后评分：100*星系+200*殖民地+5*人口+基础舰队战力+矿物/10。',
      '输入所有资源均已换算为实际单位，faction.unity及decisionFacts.unity.value范围0～100，100是最高凝聚力，基础生产/建设倍率此时1.5，绝不是极低。规则表startingUnity也为0～100显示单位。短缺仍另乘效率倍率。',
      '每轮用当前decisionFacts校核最近战略摘要，摘要可能过时或误判。对已知接壤对手比较继续和平、有限收益、准备征服或现有总体战资格。没有当前理由不等于不能prepare_conquest；资格到期后可以重新准备。乌托邦不禁止准备和总体战，实际代价是主动总体战使该任期不合格，不能误认为永久禁战。',
      '连续等待时说明具体约束及可行动的改变条件，例如本方集结到位、补给恢复、条约届满、侦察目标或当前明确的和平收益。军事未知应考虑侦察或保留预备队，不能把其他和平邻国的全部舰队加到目标国家战力。约1.5倍已知军力仅建议，局部优势、目标收益与风险由你判断；不要求开战，也不因未知而默认永久和平。公开summary简述当前选择及依据，不输出隐含推理。',
      '最多23条orders，按顺序扣除预留。保留合理维护资源；资源不足的动作会被拒绝。只给出可公开的简短战略摘要，避免冗长推演，使用一条submit_turn完成本轮。',
      '政策每届720日，含跳过锁定整届。第0日可choose_policy，换届前最后一轮可预选下届，不自动续期。穷兵黩武扩大矿业与短缺凝聚力惩罚1.5倍。正凝聚力收益受短缺影响；矿场超过2座每座-2，按殖民地人口加权。食物/电力/维护短缺每100日凝聚力-12/-4/-4。疗养所每星1座+2，度假区每星2座每座+4。自行决定建设比例，无强制行星职业。',
      'LRS每星系最多1座，电力及维护正常时探测两跳内军事信息，不泄露经济设施，也不代替探索。情报来源local/lrs/last_known分开标注；过时情报不可视作实时。',
      'V4战争：declare_war必须指定warType、systemIds、reason及grievanceId(null或有效重大理由ID)。有限军事战限一个邻接敌方基地；宣称战先create_claim，下一轮可征讨最多两个非母星目标；传教战须国教；保卫思潮须己方受到对手传教影响。总体战必须有重大理由，不能绕过条约。非总体战临时占领不吞并、不消灭最后国家；目标连续控制200日可enforce_peace，疲劳100或2160日自动结算，首次接触冲突900日归还占领。',
      'V4宗教：必须发现并可抵达圣地候选才能establish_religion。此决定永久不可撤回，永远禁用乌托邦及灯塔；当前或预约乌托邦时禁止。主圣地永久固定，祝圣前不罚未控制，祝圣后失守和伤亡会增加独立信仰危机并损害生产战力。教义只是公开叙事。可自行选择世俗、国教或连续乌托邦路线，不要求必选任何一种。',
      '传教权五年，不强迫改宗、不揭露敌方经济；三年停战期后可保卫思潮，和平时可integrate_thought。乌托邦完整任期需至少90%时间所有供应正常且不主动发动总体战，连续两届/三届成为灯塔，切换政策中断。宗教危机、圣地丢失和教派争端可能让战争胜利的收益低于代价；使用get_wars/get_faith和当前输入计算。',
      revised(state) ? '4.1：宿敌累计3场实际交战的正式战争，条约期间不消退，连续1080个无条约和平日清零。prepare_conquest可主动准备总体战：和平且情报确认法理接壤，300矿物100食物10凝聚力，360日内凝聚力额外-2/100日；成熟资格1080个自由和平日有效，cancel_conquest撤回不退款。条约内可以准备但不能宣战。用escalation.reasons里的id进行总体战，必须usable且availableDay已到。约1.5倍已知敌军仅是风险建议，不是硬规则；敌军情报不全时不要假定全国没有其他舰队。有限军事战不割地。舰队评分权重0.5，领土成果持有时100/星系，非领土目标50/去重目标全国上限500；重复打同一目标不能刷分。主动总体战使乌托邦当届不合格；自主比较和平、有限收益、征服成本和剩余时间，不要求必定开战。' : '',
      revised(state) ? JSON.stringify({ escalation: ESCALATION }) : '',
      JSON.stringify({ policies: POLICIES, rules: { ...RULES, startingUnity: RULES.startingUnity / 100 }, v4: V4, warTypes: WAR_NAMES, structures: STRUCTURES, ships: SHIPS, base: BASE }),
    ].join('\n');

    const instructions = inputMode === 'unified' ? decisionRules(state) : inputMode === 'legacy' ? legacyInstructions : [
      ...legacyInstructions.split('\n').filter(line => !['每轮用当前decisionFacts', '连续等待时', '4.1：宿敌', 'V4宗教：', '传教权五年', '达到轮数上限后', '{"policies":', '{"escalation":'].some(prefix => line.startsWith(prefix))),
      '按comparison对等比较各路线，查询get_options返回同样信息；allowed来自实际校验，战争目标来自己方情报；隐藏世界变化仍须共同结算复核。静态收支估计不保证未来供应或战况。',
      '和平扩张：收益为殖民地、人口、生产与终局分，代价是建设投资、维护与边境风险。有限目标：收益为声明的割让或目标成果，代价是军队、损失与疲劳；军事战不割地，明确退出，宣称割让不触发吞并整合。总体战：收益为吞并和淘汰，代价为准备费用、持续战争负担、伤亡与整合，且主动发动使乌托邦当届不合格。',
      '乌托邦：收益为凝聚力、人口、连续灯塔与合格任期成果，代价为电力矿物产出折损、两年锁定与供给要求；凝聚力100已封顶，其余收益按条件仍有效。宗教：收益为低危机凝聚力+4和战力×1.08、祝圣后社会协作与文明成果；代价为永久放弃乌托邦、固定主圣地与事件驱动的危机。未祝圣不会受到失守处罚；成功且供应正常可以维持低危机。',
      'prepare_conquest的和平接壤要求、300矿物100食物10凝聚力、360日准备和1080个自由和平日资格保持不变；资格成熟可用不代表必须使用。宿敌累计三场实际正式战争，不能绕过条约。军事建议只能根据有时间戳的已知敌军，不能使用未知全国军力。',
      '比较本国当前约束、剩余时间及收益选择行动，不为了路线多样性采取较差行动，不要求战争或任何政策配额。summary只写公开选择依据；旧摘要的计划不是已发生事实。',
      industrial(state) ? '4.3新增人口岗位、矿物加工合金。每人口1岗位，地表和轨道共用，缺员降低产出/民生/造舰。地表与轨道各一队列。新舰船每种造价为旧矿物价格的1/3矿物+1/3合金；原表矿物仍代表战损等效材料价值。资源库存改为矿物+2×合金，前2000价值每10计分，后8000每40计分，最多400。先用get_industry比较不建设及净收益，不能假设空槽代表满产能力。矿业、冶炼、民生、造舰均是可选路线，不强制专精。基础设施空转有维护，封存后无效果，重启100日。4.2战争成本、吞并整合、文明成果继续适用。' : balancedRules(state) ? '4.2评分：100×法理星系+200×殖民地+5×人口+0.5×基础舰队战力+矿物/10+战争成果+文明成果（共享上限1500）。总体战主动/防御每场舰船电矿维护+25%/+10%，总加成上限60%；主动总体战每场凝聚力-1/100日最多-3。吞并720实际控制日生产/建设/人口×0.5，维护全额，领土成果待整合完成。乌托邦电矿0.85，灯塔一级0.90、二级0.95，人口×1.25；凝聚力+8/+9/+10。安全且危机<20的已祝圣主圣地让全国产出×1.05。合格乌托邦或稳定信仰每届100分、持有并控制主圣地200及最多两处附属各100。' : '本对照仍使用旧修订：无战争额外维护、无吞并整合、无文明成果分；乌托邦电矿0.75，三级连续任期后0.80；没有宗教额外经济加成。score与comparison的实际修订优先。',
      JSON.stringify({ ...(industrial(state) ? { industry: INDUSTRY, effects: BUILDING_EFFECTS, labor: LABOR, expansions: EXPANSIONS, shipMaterials: Object.fromEntries(Object.keys(SHIPS).map(type => [type, Object.fromEntries(Object.entries(shipMaterials(type as keyof typeof SHIPS)).map(([k,v]) => [k,v / 1000]))])) } : {}), policies: balancedRules(state) ? { ...POLICIES, utopia: { ...POLICIES.utopia, energy: BALANCE.utopiaProduction[0], minerals: BALANCE.utopiaProduction[0] } } : POLICIES, balance: balancedRules(state) ? BALANCE : null, escalation: ESCALATION, rules: { ...RULES, startingUnity: RULES.startingUnity / 100 }, v4: V4, warTypes: WAR_NAMES, structures: STRUCTURES, ships: SHIPS, base: BASE }),
    ].join('\n');

    let retries = 0;
    try {
      while (metrics.requests < RULES.maxRequests && !staging.ended) {
        deadline.throwIfAborted();
        metrics.requests++;
        onProgress(`SSE 连接中 · 请求 ${metrics.requests}/${RULES.maxRequests}`, metrics.requests, staging.actions.length);
        let response: ModelResponse;
        try {
          const body = { model: state.config.models[factionId], instructions, input, tools: toolDefinitions(true, state), tool_choice: { type: 'function', name: 'submit_turn' }, reasoning: { effort: 'low' }, max_output_tokens: outputLimit(state), store: false, stream: true };
          await audit('model.request', { request: metrics.requests, body });
          const requestStarted = performance.now();
          let lastProgress = 0;
          response = await this.respond(body, deadline, async (responseBody, httpStatus) => { await audit('model.response', { request: metrics.requests, elapsedMs: Math.round(performance.now() - requestStarted), httpStatus, response: responseBody }); }, async progress => {
            if (lastProgress === 0 || progress.type === 'response.completed' || performance.now() - lastProgress >= 1000) {
              lastProgress = performance.now();
              await audit('model.stream', { request: metrics.requests, ...progress });
              onProgress(`SSE 接收中 · 请求 ${metrics.requests}/${RULES.maxRequests} · ${progress.events} 事件`, metrics.requests, 0);
            }
          });
        } catch (error) {
          metrics.unknownUsageRequests = (metrics.unknownUsageRequests ?? 0) + 1;
          await audit('model.failure', { usageKnown: false, request: metrics.requests, error: error instanceof Error ? error.message : String(error), retryable: error instanceof ProviderError && error.retryable });
          metrics.durationMs = Math.round(performance.now() - started); onMetrics({ ...metrics });
          if (error instanceof ProviderError && error.retryable && retries < 2 && metrics.requests < RULES.maxRequests) {
            retries++;
            await audit('model.retry', { request: metrics.requests, retry: retries });
            onProgress(`接口暂不可用，准备重试 ${retries}/2`, metrics.requests, staging.actions.length);
            await delay(retries === 1 ? 1000 : 3000, undefined, { signal: deadline });
            continue;
          }
          throw error;
        }
        deadline.throwIfAborted();
        if (!response.usage) metrics.unknownUsageRequests = (metrics.unknownUsageRequests ?? 0) + 1;
        metrics.inputTokens += response.usage?.input_tokens ?? 0;
        metrics.outputTokens += response.usage?.output_tokens ?? 0;
        metrics.totalTokens += response.usage?.total_tokens ?? (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
        metrics.reportedModel = response.model ?? state.config.models[factionId];
        metrics.durationMs = Math.round(performance.now() - started); onMetrics({ ...metrics });
        input.push(...response.output);

        const calls = response.output.filter(item => item.type === 'function_call');
        onProgress('校验完整计划', metrics.requests, 0);
        if (!calls.length) input.push({ role: 'user', content: '尚未提交计划。请调用唯一的submit_turn，等待请提交orders=[]。' });
        const multipleSubmissions = calls.filter(call => call.name === 'submit_turn').length > 1;
        for (const call of calls) {
          let result: unknown;
          if (!call.call_id || !call.name || typeof call.arguments !== 'string') throw new ProviderError('模型工具调用缺少 call_id、name 或 arguments');
          const batchId = `${response.id ?? 'response-' + metrics.requests}:${call.call_id}`;
          if (seenCalls.has(call.call_id)) result = seenCalls.get(call.call_id);
          else {
            try {
              const args = JSON.parse(call.arguments) as Record<string, unknown>;
              if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为对象');
              if (multipleSubmissions) result = { ok: false, code: 'MULTIPLE_SUBMISSIONS', error: '一个响应只能包含一个submit_turn，未接受任何计划，请重新提交唯一完整计划' };
              else if (call.name === 'submit_turn') {
                const parsed = batchSchema(state).safeParse(args);
                if (!parsed.success) result = { ok: false, code: 'BATCH_SCHEMA', errors: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })), error: '整批退回，未预留资源；请修正并重交完整计划' };
                else {
                  const candidate = new StagingArea(state, factionId);
                  const results = parsed.data.orders.map((order, index) => ({ index, ...candidate.execute(order.type, order.args) }));
                  const accepted = results.every(item => item.ok);
                  if (accepted) candidate.execute('end_turn', { summary: parsed.data.summary });
                  for (const trace of candidate.trace) traces.push({ ...trace, batchId, disposition: accepted ? 'accepted' : trace.ok ? 'rolled_back' : 'rejected' });
                  if (accepted) staging = candidate;
                  result = { ok: accepted, batchId, errors: results.filter(item => !item.ok).map(item => {
                    const message = item.error ?? '命令无效';
                    const match = /^(\w+) \[([^\]]+)\]/.exec(message);
                    return { index: item.index, subIndex: item.subIndex, code: match?.[1] ?? 'COMMAND_INVALID', path: `orders.${item.index}.args${match ? '.' + match[2] : ''}`, message };
                  }), disposition: accepted ? 'accepted' : 'rolled_back', results, error: accepted ? null : '整批退回：包含校验成功的命令也已回滚，资源预留为零，请重新提交完整orders', reservedResources: accepted ? candidate.draft.factions[factionId].resources : state.factions[factionId].resources };
                }
              } else if (call.name.startsWith('get_') && toolDefinitions(true, state).some(tool => tool.name === call.name)) result = new StagingArea(state, factionId).execute(call.name, args);
              else result = { ok: false, code: 'USE_SUBMIT_TURN', error: '所有行动必须放入唯一submit_turn；空计划也用submit_turn' };
            } catch { result = { ok: false, code: 'INVALID_JSON', error: '工具参数不是合法JSON对象，请重新提交完整计划' }; }
            seenCalls.set(call.call_id, result);
          }
          await audit('model.tool', { responseId: response.id, batchId, request: metrics.requests, callId: call.call_id, name: call.name, arguments: call.arguments, result, reservedResources: staging.draft.factions[factionId].resources, reservedProjects: staging.draft.systems.flatMap(system => system.projects.filter(project => project.ownerId === factionId).map(project => ({ ...project, systemId: system.id, slot: project.structureType ? STRUCTURES[project.structureType].slot : null }))), trace: traces.filter(trace => trace.batchId === batchId) });
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
          onProgress(staging.ended ? '计划已接受，等待共同结算' : `正在纠错 · 已用 ${metrics.requests}/${RULES.maxRequests} 次请求`, metrics.requests, staging.actions.length);
        }
        if (metrics.requests === RULES.maxRequests - 1) input.push({ role: 'user', content: '这是本轮最后一次决策机会。重交完整有效的submit_turn；无法行动可明确提交orders=[]。' });
      }
      deadline.throwIfAborted();
      if (!staging.ended) throw new ProviderError('决策预算耗尽，未收到完整有效计划；本轮未提交，请重试');
      metrics.durationMs = Math.round(performance.now() - started); onMetrics({ ...metrics });
      return sanitize({ actions: staging.actions, summary: redact(staging.summary, this.config.key).slice(0, 1000), trace: traces.map(trace => ({ ...trace, message: redact(trace.message, this.config.key) })), metrics });
    } catch (error) {
      metrics.durationMs = Math.round(performance.now() - started); onMetrics({ ...metrics });
      if (signal.aborted) throw new Error('比赛已暂停，本轮尚未提交');
      if (deadline.aborted) throw new Error('AI决策超过180秒，比赛已暂停，可重试当前轮');
      throw new Error(redact(error instanceof Error ? error.message : 'AI决策失败', this.config.key));
    }
  }
}
