import { describe, it, expect } from 'vitest';
import { scheduleByPriority } from '../src/scheduler.js';
import type { RuntimeManifest } from '@covel/shared';

const mk = (name: string, priority: number): RuntimeManifest =>
  ({ name, priority, pluginId: name, instructions: '' }) as unknown as RuntimeManifest;

describe('scheduleByPriority — turn-band filter', () => {
  it('turn 0 keeps only priority 0-99', () => {
    const input = [mk('pregame', 10), mk('narrator', 500), mk('guide', 550)];
    const groups = scheduleByPriority(input, 0);
    expect(groups.flatMap(g => g.runtimes.map(r => r.name))).toEqual(['pregame']);
  });

  it('turn 1 drops priority 0-99 and keeps 100+', () => {
    const input = [mk('pregame', 10), mk('narrator', 500), mk('guide', 550)];
    const groups = scheduleByPriority(input, 1);
    expect(groups.flatMap(g => g.runtimes.map(r => r.name))).toEqual(['narrator', 'guide']);
  });

  it('turn 7 behaves same as turn 1', () => {
    const input = [mk('pregame', 10), mk('narrator', 500)];
    const groups = scheduleByPriority(input, 7);
    expect(groups.flatMap(g => g.runtimes.map(r => r.name))).toEqual(['narrator']);
  });

  it('sorts within the kept band', () => {
    const input = [mk('audit', 1000), mk('narrator', 500), mk('pre', 200)];
    const groups = scheduleByPriority(input, 1);
    expect(groups.map(g => g.priority)).toEqual([200, 500, 1000]);
  });

  it('groups same-priority runtimes together', () => {
    const input = [mk('a', 500), mk('b', 500), mk('c', 600)];
    const groups = scheduleByPriority(input, 1);
    expect(groups).toHaveLength(2);
    expect(groups[0].runtimes.map(r => r.name).sort()).toEqual(['a', 'b']);
    expect(groups[1].runtimes.map(r => r.name)).toEqual(['c']);
  });

  it('returns empty when no runtimes match the band', () => {
    const input = [mk('audit', 1000)];
    const groups = scheduleByPriority(input, 0);
    expect(groups).toEqual([]);
  });
});
