import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { WorkerMetric } from '../shared/types.js';
import { processLocal } from './local.js';
import type { LocalInput, LocalOutput } from './local.js';

export const maxWorkers = () => Math.max(1, availableParallelism() - 2);
export const defaultWorkers = () => Math.min(8, maxWorkers());

interface Pending { resolve: (output: LocalOutput) => void; reject: (error: Error) => void; workerIndex: number }

export class SimulationPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextJob = 0;
  private closed = false;
  private failure: Error | null = null;
  metrics: WorkerMetric[];

  constructor(readonly size = defaultWorkers()) {
    if (!Number.isInteger(size) || size < 0 || size > maxWorkers()) throw new Error(`worker 数须为0～${maxWorkers()}`);
    this.metrics = Array.from({ length: Math.max(1, size) }, (_, id) => ({ id, tasks: 0, systems: 0, durationMs: 0, threadId: 0 }));
    for (let index = 0; index < size; index++) {
      const development = import.meta.url.endsWith('.ts');
      const worker = development
        ? new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), { workerData: { entry: new URL('./worker.ts', import.meta.url).href } })
        : new Worker(new URL('./worker.js', import.meta.url));
      worker.on('message', (message: { id: number; output?: LocalOutput; error?: string; threadId: number }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error || !message.output) pending.reject(new Error(message.error ?? 'worker 返回空结果'));
        else {
          const metric = this.metrics[index];
          metric.tasks++; metric.systems += message.output.systems.length; metric.durationMs += message.output.durationMs; metric.threadId = message.threadId;
          pending.resolve(message.output);
        }
      });
      worker.on('error', error => this.fail(error));
      worker.on('exit', code => { if (!this.closed) this.fail(new Error(`模拟 worker ${index} 意外退出 (${code})`)); });
      this.workers.push(worker);
    }
  }

  private fail(error: Error) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async execute(input: LocalInput): Promise<LocalOutput[]> {
    if (this.closed || this.failure) throw this.failure ?? new Error('线程池已关闭');
    if (!this.size) {
      const result = processLocal(structuredClone(input));
      this.metrics[0].tasks++; this.metrics[0].systems += input.systems.length; this.metrics[0].durationMs += result.durationMs;
      return [result];
    }
    const count = Math.min(this.size, input.systems.length);
    const sectors: LocalInput[] = Array.from({ length: count }, () => ({ ...input, systems: [], fleets: [] }));
    const systemSector = new Map<string, number>();
    input.systems.forEach((system, index) => { sectors[index % count].systems.push(system); systemSector.set(system.id, index % count); });
    for (const fleet of input.fleets) {
      const systemId = fleet.systemId ?? (input.phase === 'combat' && fleet.departedDay === input.day ? fleet.transit?.from : null);
      if (systemId) sectors[systemSector.get(systemId)!].fleets.push(fleet);
    }
    return Promise.all(sectors.map((sector, workerIndex) => new Promise<LocalOutput>((resolve, reject) => {
      const id = this.nextJob++;
      this.pending.set(id, { resolve, reject, workerIndex });
      this.workers[workerIndex].postMessage({ id, input: sector });
    })));
  }

  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('线程池关闭'));
    this.pending.clear();
    await Promise.all(this.workers.map(worker => worker.terminate()));
  }
}
