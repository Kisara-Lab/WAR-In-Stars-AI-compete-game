import { commitActions } from '../src/sim/engine.js';
import { stateHash } from '../src/sim/math.js';
import { describe, expect, it, vi } from 'vitest';
import { readResponseStream } from '../src/server/sse.js';
import { ModelProvider } from '../src/server/provider.js';
import { createGame as createLatestGame } from '../src/sim/world.js';
const createGame: typeof createLatestGame = (config, id, revision = '4.3') => createLatestGame(config, id, revision);
import { batchCall, endCall, response } from './helpers/responses.js';

const config = { base: 'https://sse.invalid/v1', key: 'sse-test-secret' };
const stream = (source: string, chunkSize = 7) => {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
};
const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';

describe('Responses SSE', () => {
  it('4.3合金预付成功后其他动作失败，整批回滚再提交只扣一次', async () => {
    const state = createGame(), before = stateHash(state);
    let calls = 0;
    const building = { type: 'build_structure', args: { planetId: 's0-p0', structureType: 'solar_hub' } };
    const impossible = { type: 'queue_ships', args: { planetId: 's0-p0', shipType: 'dreadnought', count: 1 } };
    const provider = new ModelProvider(config, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      if (++calls === 2) expect(JSON.stringify(body.input)).toContain('rolled_back');
      return response([batchCall(calls === 1 ? [building, impossible] : [building], 'alloy-' + calls)]);
    });
    const decision = await provider.decide(state,'aurora',new AbortController().signal);
    expect(decision.metrics.requests).toBe(2);
    expect(decision.actions).toEqual([building]);
    expect(stateHash(state)).toBe(before);
    expect(decision.trace.some(t=>t.disposition==='rolled_back')).toBe(true);
    const committed = commitActions(state,{aurora:decision.actions});
    expect(committed.factions.aurora.resources.alloys).toBe(60000);
    expect(committed.factions.aurora.resources.minerals).toBe(380000);
    expect(committed.systems[0].projects).toHaveLength(1);
  });

  it('分片UTF8、心跳、多行data、交错参数与重复sequence只产生一次完成结果', async () => {
    const first = { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'submit_turn', arguments: '' };
    const second = { id: 'item-b', type: 'function_call', call_id: 'call-b', name: 'get_report', arguments: '' };
    const argumentsText = JSON.stringify({ orders: [], summary: '星海和平，等待。' });
    const delta = { type: 'response.function_call_arguments.delta', response_id: 'resp', output_index: 0, item_id: 'item-a', sequence_number: 3, delta: argumentsText };
    const completed = { type: 'response.completed', sequence_number: 8, response: { id: 'resp', status: 'completed', output: [{ ...first, arguments: argumentsText }, { ...second, arguments: '{}' }], usage: { total_tokens: 20 } } };
    const source = ': heartbeat\r\n\r\n' + 'event: response.created\ndata: {"type":"response.created",\ndata: "response":{"id":"resp"}}\n\n' +
      event({ type: 'response.output_item.added', output_index: 0, item: first }) +
      event({ type: 'response.output_item.added', output_index: 1, item: second }) + event(delta) + event(delta) +
      event({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'item-b', delta: '{}' }) +
      event({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item-a', arguments: argumentsText }) + event(completed) + event(completed);
    const progress: unknown[] = [];
    const result = await readResponseStream(stream(source, 1), new AbortController().signal, async value => { progress.push(value); });
    expect(result.output[0].arguments).toBe(argumentsText);
    expect(result.usage?.total_tokens).toBe(20);
    expect(JSON.stringify(progress)).not.toContain('星海');
    expect(progress).toHaveLength(7);
  });

  it.each(['response.failed', 'response.incomplete', 'error'])('拒绝 %s，即使已经收到工具参数', async type => {
    await expect(readResponseStream(stream(event({ type })), new AbortController().signal, async () => {})).rejects.toThrow(type);
  });

  it('缺少完成事件或JSON正文不能当成成功', async () => {
    await expect(readResponseStream(stream(event({ type: 'response.output_item.done', output_index: 0, item: endCall() })), new AbortController().signal, async () => {})).rejects.toThrow('completed');
    await expect(readResponseStream(new Response('{}'), new AbortController().signal, async () => {})).rejects.toThrow('未返回 SSE');
  });

  it('拒绝交叉response ID和无法关联的参数', async () => {
    const source = event({ type: 'response.created', response: { id: 'first' } }) + event({ type: 'response.created', response: { id: 'second' } });
    await expect(readResponseStream(stream(source), new AbortController().signal, async () => {})).rejects.toThrow('不同 response');
    await expect(readResponseStream(stream(event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' })), new AbortController().signal, async () => {})).rejects.toThrow('无法关联');
  });

  it('收到半截参数后暂停立即取消流，不产生决策', async () => {
    const abort = new AbortController();
    let cancelled = false;
    const provider = new ModelProvider(config, async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event({ type: 'response.created', response: { id: 'pending' } })));
      setTimeout(() => abort.abort('user_pause'), 10);
    }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(provider.decide(createGame(), 'aurora', abort.signal)).rejects.toThrow('比赛已暂停');
    expect(cancelled).toBe(true);
  });

  it('90秒超时包含流读取时间', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), 10);
      return controller.signal;
    });
    try {
      const provider = new ModelProvider(config, async () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }));
      await expect(provider.respond({}, new AbortController().signal)).rejects.toThrow('90秒');
    } finally { timeout.mockRestore(); }
  });

  it('断流重试统计未知usage，完整工具出现前不执行', async () => {
    let calls = 0;
    const provider = new ModelProvider(config, async () => ++calls === 1 ? stream(event({ type: 'response.output_item.done', output_index: 0, item: endCall() })) : response([endCall()]));
    const decision = await provider.decide(createGame(), 'aurora', new AbortController().signal);
    expect(decision.metrics).toMatchObject({ requests: 2, totalTokens: 30, unknownUsageRequests: 1 });
    expect(decision.trace).toHaveLength(1);
  });

  it('500服务端错误使用同一请求预算重试', async () => {
    let calls = 0;
    const provider = new ModelProvider(config, async () => ++calls === 1 ? new Response('{"error":{"message":"temporary"}}', { status: 500 }) : response([endCall()]));
    const decision = await provider.decide(createGame(), 'aurora', new AbortController().signal);
    expect(decision.metrics).toMatchObject({ requests: 2, totalTokens: 30, unknownUsageRequests: 1 });
  });

  it('多个最终提交整批拒绝，允许下一请求提交空计划', async () => {
    let calls = 0;
    const provider = new ModelProvider(config, async () => ++calls === 1 ? response([batchCall([], 'one'), batchCall([], 'two')]) : response([endCall()]));
    const decision = await provider.decide(createGame(), 'aurora', new AbortController().signal);
    expect(decision.metrics.requests).toBe(2);
    expect(decision.actions).toEqual([]);
  });

  it('24条orders超过最终动作额度，纠错后23条额度不受失败批次影响', async () => {
    let calls = 0;
    const state = createGame();
    const orders = Array.from({ length: 24 }, () => ({ type: 'move_fleet', args: { fleetId: 'aurora-initial', systemId: state.factions.aurora.homeSystemId, x: 500, y: 500, targetFleetId: null } }));
    const provider = new ModelProvider(config, async () => response([batchCall(++calls === 1 ? orders : orders.slice(0, 23), 'request-' + calls)]));
    const decision = await provider.decide(state, 'aurora', new AbortController().signal);
    expect(decision.metrics.requests).toBe(2);
    expect(decision.actions).toHaveLength(23);
  });
});
