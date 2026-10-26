import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableParallelism } from 'node:os';
import { defaultWorkers, maxWorkers, SimulationPool } from '../src/sim/pool.js';

vi.mock('node:os', () => ({ availableParallelism: vi.fn(() => 2) }));
afterEach(() => vi.mocked(availableParallelism).mockReturnValue(2));

describe('worker configuration on small machines', () => {
  it('keeps automatic sizing conservative while allowing explicit eight-worker runs', async () => {
    expect(defaultWorkers()).toBe(1);
    expect(maxWorkers()).toBe(8);
    const pool = new SimulationPool(8);
    try { expect(pool.size).toBe(8); }
    finally { await pool.close(); }
  });

  it('reserves two CPUs for automatic sizing and caps the default at eight', () => {
    vi.mocked(availableParallelism).mockReturnValue(4);
    expect(defaultWorkers()).toBe(2);
    vi.mocked(availableParallelism).mockReturnValue(16);
    expect(defaultWorkers()).toBe(8);
    expect(maxWorkers()).toBe(14);
  });

  it('rejects invalid explicit sizes before spawning workers', () => {
    for (const size of [-1, 0.5, NaN, Infinity, 9]) {
      expect(() => new SimulationPool(size)).toThrow();
    }
  });
});
