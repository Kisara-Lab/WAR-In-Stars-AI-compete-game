export interface ResponseItem {
  type: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
  [key: string]: unknown;
}
export interface ModelResponse {
  id?: string;
  model?: string;
  status?: string;
  output: ResponseItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
export interface StreamProgress { responseId?: string; events: number; bytes: number; type: string }

export async function readResponseStream(response: Response, signal: AbortSignal, progress: (value: StreamProgress) => Promise<void>): Promise<ModelResponse> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw new ProviderError('接口未返回 SSE text/event-stream，未降级为 JSON');
  if (!response.body) throw new ProviderError('SSE 响应缺少正文', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const items = new Map<number, ResponseItem>();
  const sequences = new Set<number>();
  let buffer = '';
  let data: string[] = [];
  let responseId: string | undefined;
  let completed: ModelResponse | undefined;
  let events = 0;
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const dispatch = async () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return;
    let event: Record<string, any>;
    try { event = JSON.parse(payload); } catch { throw new ProviderError('SSE 事件不是合法 JSON'); }
    if (!event || typeof event.type !== 'string') throw new ProviderError('SSE 事件缺少 type');
    if (typeof event.sequence_number === 'number') {
      if (sequences.has(event.sequence_number)) return;
      sequences.add(event.sequence_number);
    }
    const eventId = event.response_id ?? event.response?.id;
    if (eventId && responseId && eventId !== responseId) throw new ProviderError('SSE 混入不同 response ID');
    responseId ??= eventId;
    events++;
    if (event.type === 'response.output_item.added') items.set(event.output_index, { ...event.item });
    if (event.type === 'response.function_call_arguments.delta') {
      const item = items.get(event.output_index);
      if (!item || item.type !== 'function_call' || event.item_id && item.id !== event.item_id || typeof event.delta !== 'string') throw new ProviderError('SSE 工具参数无法关联输出项');
      item.arguments = (item.arguments ?? '') + event.delta;
    }
    if (event.type === 'response.function_call_arguments.done') {
      const item = items.get(event.output_index);
      if (!item || event.item_id && item.id !== event.item_id || typeof event.arguments !== 'string') throw new ProviderError('SSE 完整工具参数无效');
      item.arguments = event.arguments;
    }
    if (event.type === 'response.output_item.done') items.set(event.output_index, { ...event.item });
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw new ProviderError('SSE 返回 ' + event.type + '，本响应未提交', true);
    if (event.type === 'response.completed') {
      if (!event.response || event.response.status !== 'completed' || !Array.isArray(event.response.output)) throw new ProviderError('SSE 完成事件缺少完整 output 或 completed 状态');
      for (const item of event.response.output) if (item.type === 'function_call' && (typeof item.arguments !== 'string' || !item.name || !item.call_id)) throw new ProviderError('SSE 完成事件工具调用不完整');
      completed = event.response as ModelResponse;
    }
    await progress({ responseId, events, bytes, type: event.type });
  };
  try {
    while (!completed) {
      signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { signal.throwIfAborted(); throw new ProviderError('SSE 读取中断', true); }
      signal.throwIfAborted();
      bytes += chunk.value?.byteLength ?? 0;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 8_000_000 || bytes > 32_000_000) throw new ProviderError('SSE 响应超出大小限制');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) await dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (completed) break;
      }
      if (chunk.done && !completed) throw new ProviderError('SSE 在 response.completed 前结束，usage 未知，未执行命令', true);
    }
    return completed;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
