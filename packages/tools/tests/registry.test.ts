import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { generateToolName, createToolRegistry } from '../src/registry.js';
import { tool } from '../src/tool.js';
import type { ResolvedTool } from '../src/types.js';
import type { RuntimeManifest } from '@covel/shared';

// ── Helper ───────────────────────────────────────────────────────

function makeResolved(overrides: Partial<ResolvedTool> & Pick<ResolvedTool, 'fullName' | 'localName' | 'pluginId' | 'runtimeId' | 'source'>): ResolvedTool {
  const mod = tool({
    name: overrides.localName,
    description: 'test tool',
    parameters: z.object({}),
    execute: async () => ({}),
  });
  return {
    module: mod,
    requiresApproval: false,
    ...overrides,
  };
}

// ── generateToolName ─────────────────────────────────────────────

describe('generateToolName', () => {
  it('joins segments with underscores and replaces hyphens', () => {
    expect(generateToolName('image-workflow', 'prompt-optimizer', 'fetch-style'))
      .toBe('covel_image_workflow_prompt_optimizer_fetch_style');
  });

  it('works with single-word segments', () => {
    expect(generateToolName('narrator', 'main', 'get-info'))
      .toBe('covel_narrator_main_get_info');
  });
});

// ── ToolRegistry ─────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ReturnType<typeof createToolRegistry>;

  beforeEach(() => {
    registry = createToolRegistry();
  });

  it('register and getByFullName returns the tool', () => {
    const resolved = makeResolved({
      fullName: 'covel_myplugin_main_do_thing',
      localName: 'do-thing',
      pluginId: 'myplugin',
      runtimeId: 'main',
      source: 'local',
    });
    registry.register(resolved);
    expect(registry.getByFullName('covel_myplugin_main_do_thing')).toBe(resolved);
  });

  it('getByFullName returns undefined for unknown tools', () => {
    expect(registry.getByFullName('covel_unknown_tool')).toBeUndefined();
  });

  it('size reflects the number of registered tools', () => {
    registry.register(makeResolved({ fullName: 'covel_a_b_c1', localName: 'c1', pluginId: 'a', runtimeId: 'b', source: 'local' }));
    registry.register(makeResolved({ fullName: 'covel_a_b_c2', localName: 'c2', pluginId: 'a', runtimeId: 'b', source: 'local' }));
    registry.register(makeResolved({ fullName: 'covel_a_b_c3', localName: 'c3', pluginId: 'a', runtimeId: 'b', source: 'local' }));
    expect(registry.size).toBe(3);
  });

  it('getToolsForRuntime returns builtin tools declared in manifest', () => {
    const builtinTool = makeResolved({
      fullName: 'covel_system_builtin_get_game_context',
      localName: 'get-game-context',
      pluginId: 'system',
      runtimeId: 'builtin',
      source: 'builtin',
    });
    registry.register(builtinTool);

    const manifest: RuntimeManifest = {
      name: 'test-runtime',
      description: 'Test',
      priority: 500,
      tools: { builtin: ['get-game-context'] },
    };

    const result = registry.getToolsForRuntime('myplugin', 'main', manifest);
    expect(result).toContain(builtinTool);
  });

  it('getToolsForRuntime returns local tools for the given plugin/runtime', () => {
    const localTool = makeResolved({
      fullName: 'covel_myplugin_main_my_tool',
      localName: 'my-tool',
      pluginId: 'myplugin',
      runtimeId: 'main',
      source: 'local',
    });
    registry.register(localTool);

    const manifest: RuntimeManifest = {
      name: 'main',
      description: 'Main runtime',
      priority: 500,
      tools: { local: ['./tools/my-tool.js'] },
    };

    const result = registry.getToolsForRuntime('myplugin', 'main', manifest);
    expect(result).toContain(localTool);
  });

  it('getToolsForRuntime filters correctly — only declared tools', () => {
    const declaredTool = makeResolved({
      fullName: 'covel_system_builtin_get_game_context',
      localName: 'get-game-context',
      pluginId: 'system',
      runtimeId: 'builtin',
      source: 'builtin',
    });
    const otherBuiltin = makeResolved({
      fullName: 'covel_system_builtin_other_tool',
      localName: 'other-tool',
      pluginId: 'system',
      runtimeId: 'builtin',
      source: 'builtin',
    });
    const localOwned = makeResolved({
      fullName: 'covel_myplugin_main_owned',
      localName: 'owned',
      pluginId: 'myplugin',
      runtimeId: 'main',
      source: 'local',
    });
    const localOther = makeResolved({
      fullName: 'covel_other_main_foreign',
      localName: 'foreign',
      pluginId: 'other',
      runtimeId: 'main',
      source: 'local',
    });
    registry.register(declaredTool);
    registry.register(otherBuiltin);
    registry.register(localOwned);
    registry.register(localOther);

    const manifest: RuntimeManifest = {
      name: 'main',
      description: 'Main runtime',
      priority: 500,
      tools: {
        builtin: ['get-game-context'],
        local: ['./tools/owned.js'],
      },
    };

    const result = registry.getToolsForRuntime('myplugin', 'main', manifest);
    expect(result).toContain(declaredTool);
    expect(result).toContain(localOwned);
    expect(result).not.toContain(otherBuiltin);
    expect(result).not.toContain(localOther);
  });

  it('unregisterPlugin removes all tools for a plugin', () => {
    registry.register(makeResolved({ fullName: 'covel_plug_a_t1', localName: 't1', pluginId: 'plug', runtimeId: 'a', source: 'local' }));
    registry.register(makeResolved({ fullName: 'covel_plug_a_t2', localName: 't2', pluginId: 'plug', runtimeId: 'a', source: 'local' }));
    registry.register(makeResolved({ fullName: 'covel_other_b_t3', localName: 't3', pluginId: 'other', runtimeId: 'b', source: 'local' }));
    expect(registry.size).toBe(3);

    registry.unregisterPlugin('plug');
    expect(registry.size).toBe(1);
    expect(registry.getByFullName('covel_plug_a_t1')).toBeUndefined();
    expect(registry.getByFullName('covel_plug_a_t2')).toBeUndefined();
    expect(registry.getByFullName('covel_other_b_t3')).toBeDefined();
  });
});
