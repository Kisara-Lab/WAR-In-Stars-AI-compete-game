export function response(output: unknown[], usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30 }) {
  return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'test-response', model: 'grok-4.7-build', status: 'completed', output, usage } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
export const endCall = () => ({ type: 'function_call', name: 'submit_turn', call_id: 'finish', arguments: JSON.stringify({ orders: [], summary: '保留资源，准备扩张。' }) });
export const batchCall = (orders: unknown[], callId = 'batch', summary = '公开计划') => ({ type: 'function_call', name: 'submit_turn', call_id: callId, arguments: JSON.stringify({ orders, summary }) });
