import { describe, it, expect } from 'vitest';
import type { RuntimeManifest } from '@covel/shared';
import type { DependencyEdge } from '../src/types.js';
import {
  scheduleByPriority,
  extractDependencies,
  detectCycles,
} from '../src/scheduler.js';

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

describe('extractDependencies', () => {
  // 5. inject dependency
  it('should extract dependency from input.inject', () => {
    const runtimes = [
      makeManifest({
        name: 'consumer',
        input: {
          inject: [{ from: 'narrator/main', field: 'output', as: '<out>' }],
        },
      }),
    ];
    const edges = extractDependencies(runtimes);
    expect(edges).toEqual([
      { dependent: 'consumer', dependency: 'narrator/main' },
    ]);
  });

  // 6. tool dependency
  it('should extract dependency from input.tools', () => {
    const runtimes = [
      makeManifest({
        name: 'tracker',
        input: {
          tools: [{ plugin: 'states', runtime: 'char' }],
        },
      }),
    ];
    const edges = extractDependencies(runtimes);
    expect(edges).toEqual([
      { dependent: 'tracker', dependency: 'states/char' },
    ]);
  });

  // 7. no dependencies
  it('should return empty edges when runtime has no input', () => {
    const runtimes = [makeManifest({ name: 'standalone' })];
    const edges = extractDependencies(runtimes);
    expect(edges).toEqual([]);
  });

  // 8. multiple dependencies
  it('should extract multiple edges from inject and tools', () => {
    const runtimes = [
      makeManifest({
        name: 'complex',
        input: {
          inject: [{ from: 'narrator/main', field: 'output', as: '<out>' }],
          tools: [{ plugin: 'states', runtime: 'char' }],
        },
      }),
    ];
    const edges = extractDependencies(runtimes);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({
      dependent: 'complex',
      dependency: 'narrator/main',
    });
    expect(edges).toContainEqual({
      dependent: 'complex',
      dependency: 'states/char',
    });
  });
});

describe('detectCycles', () => {
  // 9. No cycles
  it('should return empty array when there are no cycles', () => {
    const edges: readonly DependencyEdge[] = [
      { dependent: 'B', dependency: 'A' },
      { dependent: 'C', dependency: 'B' },
    ];
    expect(detectCycles(edges)).toEqual([]);
  });

  // 10. Simple cycle
  it('should detect a simple cycle', () => {
    const edges: readonly DependencyEdge[] = [
      { dependent: 'B', dependency: 'A' },
      { dependent: 'A', dependency: 'B' },
    ];
    const cycles = detectCycles(edges);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    // The cycle should contain both A and B
    const flatCycle = cycles[0];
    expect(flatCycle).toContain('A');
    expect(flatCycle).toContain('B');
  });

  // 11. No edges
  it('should return empty array when there are no edges', () => {
    expect(detectCycles([])).toEqual([]);
  });
});
