import { describe, it, expect } from 'vitest';
import type { RuntimeManifest } from '@covel/shared';
import { scheduleByPriority } from '../src/scheduler.js';

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
}

describe('scheduleByPriority', () => {
  // 1. Single group — all same priority
  it('should return 1 group when all runtimes have the same priority', () => {
    const runtimes = [
      makeManifest({ name: 'a', priority: 500 }),
      makeManifest({ name: 'b', priority: 500 }),
      makeManifest({ name: 'c', priority: 500 }),
    ];
    const groups = scheduleByPriority(runtimes);
    expect(groups).toHaveLength(1);
    expect(groups[0].priority).toBe(500);
    expect(groups[0].runtimes).toHaveLength(3);
  });

  // 2. Multiple groups — sorted ascending
  it('should return groups sorted by ascending priority', () => {
    const runtimes = [
      makeManifest({ name: 'a', priority: 500 }),
      makeManifest({ name: 'b', priority: 100 }),
      makeManifest({ name: 'c', priority: 500 }),
      makeManifest({ name: 'd', priority: 800 }),
    ];
    const groups = scheduleByPriority(runtimes);
    expect(groups).toHaveLength(3);
    expect(groups[0].priority).toBe(100);
    expect(groups[0].runtimes).toHaveLength(1);
    expect(groups[1].priority).toBe(500);
    expect(groups[1].runtimes).toHaveLength(2);
    expect(groups[2].priority).toBe(800);
    expect(groups[2].runtimes).toHaveLength(1);
  });

  // 3. Empty input
  it('should return empty array for empty input', () => {
    expect(scheduleByPriority([])).toEqual([]);
  });

  // 4. Already sorted
  it('should handle already sorted priorities', () => {
    const runtimes = [
      makeManifest({ name: 'a', priority: 0 }),
      makeManifest({ name: 'b', priority: 250 }),
      makeManifest({ name: 'c', priority: 500 }),
      makeManifest({ name: 'd', priority: 1000 }),
    ];
    const groups = scheduleByPriority(runtimes);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.priority)).toEqual([0, 250, 500, 1000]);
  });
});
