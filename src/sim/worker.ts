import { parentPort, threadId } from 'node:worker_threads';
import type { LocalInput } from './local.js';
import { processLocal } from './local.js';

parentPort!.on('message', ({ id, input }: { id: number; input: LocalInput }) => {
  try { parentPort!.postMessage({ id, output: processLocal(input), threadId }); }
  catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : '模拟任务失败', threadId }); }
});
