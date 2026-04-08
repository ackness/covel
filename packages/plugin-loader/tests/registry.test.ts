import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RuntimeManifest, PluginType } from '@covel/shared';
import type {
  PluginRegistryEntry,
  PluginSummary,
  ParsedPluginMd,
  RegistryChangeEvent,
} from '../src/types.js';
import { createPluginRegistry, type PluginRegistry } from '../src/registry.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeSummary(
  id: string,
  overrides?: Partial<PluginSummary>,
): PluginSummary {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Description for ${id}`,
    pluginType: 'plugin' as PluginType,
    runtimeCount: 1,
    ...overrides,
  };
}

function makeRuntimeManifest(
  name: string,
  priority: number,
): RuntimeManifest {
  return {
    name,
    description: `Runtime ${name}`,
    priority,
  };
}

function makeParsedPluginMd(
  name: string,
  priority: number,
): ParsedPluginMd {
  return {
    manifest: makeRuntimeManifest(name, priority),
    promptTemplate: '',
    referenceLinks: [],
    rawFrontmatter: {},
  };
}

function makeEntry(
  id: string,
  overrides?: Partial<PluginRegistryEntry>,
): PluginRegistryEntry {
  return {
    id,
    summary: makeSummary(id),
    loadedRuntimes: new Map(),
    status: 'registered',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createPluginRegistry();
  });

  describe('register and get', () => {
    it('should register an entry and retrieve it by ID', () => {
      const entry = makeEntry('alpha');
      registry.register(entry);

      const result = registry.get('alpha');
      expect(result).toBeDefined();
      expect(result!.id).toBe('alpha');
      expect(result!.summary.name).toBe('Plugin alpha');
    });
  });

  describe('getAll', () => {
    it('should return a map containing all registered entries', () => {
      registry.register(makeEntry('a'));
      registry.register(makeEntry('b'));

      const all = registry.getAll();
      expect(all.size).toBe(2);
      expect(all.has('a')).toBe(true);
      expect(all.has('b')).toBe(true);
    });
  });

  describe('get unknown', () => {
    it('should return undefined for a non-existent ID', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('activate', () => {
    it('should activate a plugin for a session', () => {
      const entry = makeEntry('alpha');
      registry.register(entry);

      registry.activate('alpha', 'session-1');

      // After activation, the entry should still be retrievable
      const result = registry.get('alpha');
      expect(result).toBeDefined();
    });
  });

  describe('deactivate', () => {
    it('should deactivate a plugin for a session', () => {
      registry.register(makeEntry('alpha'));
      registry.activate('alpha', 'session-1');
      registry.deactivate('alpha', 'session-1');

      // Plugin should still be in the registry
      expect(registry.get('alpha')).toBeDefined();
    });
  });

  describe('onChange fires on register', () => {
    it('should notify handler with plugin-registered event', () => {
      const handler = vi.fn<(event: RegistryChangeEvent) => void>();
      registry.onChange(handler);

      registry.register(makeEntry('alpha'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: 'plugin-registered',
        pluginId: 'alpha',
      });
    });
  });

  describe('onChange fires on activate', () => {
    it('should notify handler with plugin-activated event including sessionId', () => {
      registry.register(makeEntry('alpha'));

      const handler = vi.fn<(event: RegistryChangeEvent) => void>();
      registry.onChange(handler);

      registry.activate('alpha', 'session-1');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: 'plugin-activated',
        pluginId: 'alpha',
        sessionId: 'session-1',
      });
    });
  });

  describe('onChange unsubscribe', () => {
    it('should stop notifying after unsubscribe is called', () => {
      const handler = vi.fn<(event: RegistryChangeEvent) => void>();
      const unsubscribe = registry.onChange(handler);

      registry.register(makeEntry('a'));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      registry.register(makeEntry('b'));
      expect(handler).toHaveBeenCalledTimes(1); // still 1, not 2
    });
  });

  describe('getActiveRuntimes', () => {
    it('should return runtime manifests from active plugins sorted by priority ascending', () => {
      const entryLow = makeEntry('low', {
        manifest: makeParsedPluginMd('low-runtime', 800),
      });
      const entryHigh = makeEntry('high', {
        manifest: makeParsedPluginMd('high-runtime', 100),
      });
      const entryMid = makeEntry('mid', {
        manifest: makeParsedPluginMd('mid-runtime', 500),
      });

      registry.register(entryLow);
      registry.register(entryHigh);
      registry.register(entryMid);

      registry.activate('low', 'session-1');
      registry.activate('high', 'session-1');
      registry.activate('mid', 'session-1');

      const runtimes = registry.getActiveRuntimes('session-1');

      expect(runtimes).toHaveLength(3);
      expect(runtimes[0].name).toBe('high-runtime');
      expect(runtimes[0].priority).toBe(100);
      expect(runtimes[1].name).toBe('mid-runtime');
      expect(runtimes[1].priority).toBe(500);
      expect(runtimes[2].name).toBe('low-runtime');
      expect(runtimes[2].priority).toBe(800);
    });

    it('should return empty array for session with no active plugins', () => {
      expect(registry.getActiveRuntimes('empty-session')).toEqual([]);
    });

    it('should not include inactive plugins', () => {
      const entry = makeEntry('alpha', {
        manifest: makeParsedPluginMd('alpha-runtime', 500),
      });
      registry.register(entry);
      // Not activated for session-1

      expect(registry.getActiveRuntimes('session-1')).toEqual([]);
    });
  });
});
