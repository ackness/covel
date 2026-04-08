import { describe, it, expect } from 'vitest';
import type { RuntimeManifest } from '@covel/shared';
import type { PluginLlmConfig } from '@covel/plugin-loader';
import { createModelResolver } from '../src/model-resolver.js';

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
}

describe('createModelResolver', () => {
  // Plugin "narrator-a" has its own llm.toml with [plugin.default] and [plugin.fast]
  // Plugin "narrator-b" has only [plugin.default]
  const pluginConfigs = new Map<string, PluginLlmConfig>([
    ['narrator-a', {
      defaultSlot: { provider: 'dashscope', model: 'qwen3.5-flash' },
      slots: {
        default: { provider: 'dashscope', model: 'qwen3.5-flash' },
        fast: { provider: 'dashscope', model: 'qwen3.5-turbo-plugin' },
      },
    }],
    ['narrator-b', {
      defaultSlot: { provider: 'deepseek', model: 'deepseek-plugin' },
      slots: {
        default: { provider: 'deepseek', model: 'deepseek-plugin' },
      },
    }],
  ]);

  const resolve = createModelResolver({ pluginLlmConfigs: pluginConfigs });

  describe('PLUGIN.md model → plugin llm.toml takes priority over system', () => {
    it('model: "fast" resolves to plugin llm.toml [plugin.fast] when it exists', () => {
      // narrator-a has [plugin.fast] = qwen3.5-turbo-plugin
      // System also has [slots.fast] but plugin wins
      const manifest = makeManifest({ name: 'narrator-a', model: 'fast' });
      expect(resolve(manifest)).toBe('qwen3.5-turbo-plugin');
    });

    it('model: "fast" falls through to system slot when plugin has no [plugin.fast]', () => {
      // narrator-b has no [plugin.fast], so "fast" passes through to system
      const manifest = makeManifest({ name: 'narrator-b', model: 'fast' });
      expect(resolve(manifest)).toBe('fast'); // system gateway resolves "fast"
    });

    it('model: "ds" passes through to system when plugin has no [plugin.ds]', () => {
      const manifest = makeManifest({ name: 'narrator-a', model: 'ds' });
      // narrator-a has no [plugin.ds], so "ds" goes to system gateway
      expect(resolve(manifest)).toBe('ds');
    });
  });

  describe('no model in PLUGIN.md → plugin llm.toml [plugin.default]', () => {
    it('uses plugin default when no model field', () => {
      const manifest = makeManifest({ name: 'narrator-a' }); // no model
      expect(resolve(manifest)).toBe('qwen3.5-flash'); // plugin.default
    });

    it('uses plugin default from different plugin', () => {
      const manifest = makeManifest({ name: 'narrator-b' });
      expect(resolve(manifest)).toBe('deepseek-plugin');
    });
  });

  describe('no plugin llm.toml → system default', () => {
    it('returns undefined when no model and no plugin config', () => {
      const manifest = makeManifest({ name: 'unknown-plugin' });
      expect(resolve(manifest)).toBeUndefined();
    });
  });

  describe('API override', () => {
    it('API override bypasses everything', () => {
      const manifest = makeManifest({ name: 'narrator-a', model: 'fast' });
      // Even though plugin has [plugin.fast], API says "free"
      expect(resolve(manifest, 'free')).toBe('free');
    });

    it('API override checks plugin config first for the given name', () => {
      // API says "fast", plugin narrator-a has [plugin.fast]
      // → resolves to plugin's version of "fast"
      const manifest = makeManifest({ name: 'narrator-a' });
      expect(resolve(manifest, 'fast')).toBe('qwen3.5-turbo-plugin');
    });

    it('API override falls to system when plugin has no matching slot', () => {
      // API says "image", plugin narrator-a has no [plugin.image]
      const manifest = makeManifest({ name: 'narrator-a' });
      expect(resolve(manifest, 'image')).toBe('image');
    });
  });
});
