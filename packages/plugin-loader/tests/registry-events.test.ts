/**
 * Tests for PluginRegistry EventBus bridge — verifies plugin lifecycle
 * events are emitted to the EventBus when one is provided.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginType, SubscriptionEvent } from '@covel/shared';
import type { PluginRegistryEntry, PluginSummary } from '../src/types.js';
import { createPluginRegistry, type PluginRegistry } from '../src/registry.js';
import { createEventBus, type EventBus } from '@covel/events';

function makeSummary(id: string): PluginSummary {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Description for ${id}`,
    pluginType: 'plugin' as PluginType,
    runtimeCount: 1,
  };
}

function makeEntry(id: string): PluginRegistryEntry {
  return {
    id,
    summary: makeSummary(id),
    loadedRuntimes: new Map(),
    status: 'registered',
  };
}

describe('PluginRegistry EventBus Bridge', () => {
  let registry: PluginRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    registry = createPluginRegistry({ eventBus });
  });

  it('should emit plugin.activated event on activate()', () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    registry.register(makeEntry('alpha'));
    registry.activate('alpha', 'session-1');

    const activated = events.find((e) => e.type === 'plugin.activated');
    expect(activated).toBeDefined();
    expect(activated!.topic).toBe('plugin');
    expect(activated!.sessionId).toBe('session-1');
    expect((activated!.payload as Record<string, unknown>).pluginId).toBe('alpha');
  });

  it('should emit plugin.deactivated event on deactivate()', () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    registry.register(makeEntry('alpha'));
    registry.activate('alpha', 'session-1');
    registry.deactivate('alpha', 'session-1');

    const deactivated = events.find((e) => e.type === 'plugin.deactivated');
    expect(deactivated).toBeDefined();
    expect(deactivated!.topic).toBe('plugin');
    expect(deactivated!.sessionId).toBe('session-1');
    expect((deactivated!.payload as Record<string, unknown>).pluginId).toBe('alpha');
  });

  it('should work without eventBus (backward compat)', () => {
    const noEventBusRegistry = createPluginRegistry();
    noEventBusRegistry.register(makeEntry('beta'));
    noEventBusRegistry.activate('beta', 'session-1');
    noEventBusRegistry.deactivate('beta', 'session-1');
    // No errors thrown
    expect(noEventBusRegistry.get('beta')).toBeDefined();
  });
});
