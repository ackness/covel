/**
 * Miscellaneous API routes — presets, packages, commands, block-schemas, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import { Hono } from 'hono';
import type { AiStack } from '../ai-setup.js';
import type { PluginRegistry } from '@covel/plugin-loader';

export function createMiscApiRoutes(ai: AiStack, registry: PluginRegistry): Hono {
  const app = new Hono();

  // GET /api/presets — list configured model presets
  app.get('/api/presets', (c) => {
    const presets = ai.presetRegistry.listPresets().map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      enabled: p.enabled,
      isDefault: p.isDefault ?? false,
      scope: 'global',
    }));
    return c.json(presets);
  });

  // GET /api/packages — list loaded plugin packages with runtime/tool info
  app.get('/api/packages', (c) => {
    const all = registry.getAll();
    const packages: Array<Record<string, unknown>> = [];
    const loadErrors: Array<{ pluginId: string; errors: string[] }> = [];

    for (const [, entry] of all) {
      if (entry.status === 'error' && entry.error) {
        loadErrors.push({ pluginId: entry.id, errors: [entry.error] });
        continue;
      }

      const runtimes = (entry.manifests ?? (entry.manifest ? [entry.manifest] : [])).map((m) => ({
        id: m.manifest.name,
        kind: m.manifest.runtimeType ?? 'agent',
        priority: m.manifest.priority ?? 500,
        trigger: m.manifest.trigger ?? { mode: 'always' },
      }));

      const tools = (entry.manifests ?? (entry.manifest ? [entry.manifest] : []))
        .flatMap((m) => [
          ...(m.manifest.tools?.builtin ?? []).map((t) => ({ id: t, kind: 'builtin' })),
          ...(m.manifest.tools?.local ?? []).map((t) => {
            const basename = t.split('/').pop()?.replace(/\.[^.]+$/, '') ?? t;
            return { id: basename, kind: 'local' };
          }),
        ]);

      packages.push({
        name: entry.id,
        displayName: entry.summary.name,
        description: entry.summary.description,
        enabled: true,
        runtimes,
        tools,
      });
    }

    return c.json({ packages, loadErrors });
  });

  // GET /api/commands — list registered commands
  // TODO: populate from plugin command registry when command system is implemented
  app.get('/api/commands', (c) => {
    return c.json([]);
  });

  // GET /api/block-schemas — list block schemas from plugin manifests
  app.get('/api/block-schemas', (c) => {
    const schemas: Record<string, unknown> = {};
    const all = registry.getAll();
    for (const [, entry] of all) {
      const manifests = entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
      for (const m of manifests) {
        // blockSchemas may be declared in rawFrontmatter (from PLUGIN.md) or plugin.json
        const bs = (m.rawFrontmatter as Record<string, unknown>).blockSchemas;
        if (bs && typeof bs === 'object') {
          for (const [key, val] of Object.entries(bs as Record<string, unknown>)) {
            schemas[key] = val;
          }
        }
      }
    }
    return c.json({ schemas });
  });

  // GET /api/ui-specs — list UI specs from plugin manifests, grouped by slot
  app.get('/api/ui-specs', (c) => {
    type SlotEntry = { pluginId: string; specs: readonly Record<string, unknown>[] };
    const right: SlotEntry[] = [];
    const message: SlotEntry[] = [];
    const left: SlotEntry[] = [];

    const all = registry.getAll();
    for (const [, entry] of all) {
      if (entry.status === 'error') continue;

      for (const [, loaded] of entry.loadedRuntimes) {
        if (!loaded.uiSpecs) continue;
        const pluginId = loaded.manifest.pluginId;

        if (loaded.uiSpecs.right?.length) {
          right.push({ pluginId, specs: loaded.uiSpecs.right });
        }
        if (loaded.uiSpecs.message?.length) {
          message.push({ pluginId, specs: loaded.uiSpecs.message });
        }
        if (loaded.uiSpecs.left?.length) {
          left.push({ pluginId, specs: loaded.uiSpecs.left });
        }
      }
    }

    return c.json({ right, message, left });
  });

  // GET /api/llm-config — return slot configuration with capability info
  app.get('/api/llm-config', (c) => {
    const slots = ai.slotRegistry.listSlots();
    const slotsInfo: Record<string, Record<string, unknown>> = {};

    for (const [slotId, slot] of Object.entries(slots)) {
      const preset = ai.presetRegistry.listPresets().find((p) => p.id === slot.presetId);
      if (!preset) continue;
      slotsInfo[slotId] = {
        provider: preset.provider,
        model: preset.model,
        protocol: preset.protocol ?? 'openai',
        tag: slot.tag,
      };
    }

    return c.json({
      configured: Object.keys(slotsInfo).length > 0,
      slots: slotsInfo,
      providers: [...new Set(ai.presetRegistry.listPresets().map((p) => p.provider))],
    });
  });

  // GET /api/provider-keys — return server-configured API keys (T1 self-deploy only)
  app.get('/api/provider-keys', (c) => {
    // Security: only expose server-side keys in T1 (self-deploy) mode.
    // T2 (demo host) and T3 (commercial) must not leak API keys.
    const tier = process.env.DEPLOYMENT_TIER;
    if (tier === 'T2' || tier === 'T3') {
      return c.json({ keys: {} });
    }

    const KNOWN_PROVIDERS = ['DEEPSEEK', 'DASHSCOPE', 'OPENAI', 'ANTHROPIC', 'OPENROUTER'] as const;
    const keys: Record<string, string> = {};
    for (const provider of KNOWN_PROVIDERS) {
      const envKey = `${provider}_API_KEY`;
      const value = process.env[envKey];
      if (value) keys[provider.toLowerCase()] = value;
    }
    return c.json({ keys });
  });

  // POST /api/ai/ping — test LLM provider connectivity
  app.post('/api/ai/ping', async (c) => {
    const body = await c.req.json<{ presetId?: string }>();
    const presetId = body.presetId ?? 'default';
    const preset = ai.presetRegistry.listPresets().find((p) => p.id === presetId);
    if (!preset) {
      return c.json({ ok: false, latencyMs: 0, error: `Preset "${presetId}" not found` });
    }
    // Return basic info — actual LLM ping requires provider keys from frontend
    return c.json({
      ok: true,
      latencyMs: 0,
      text: `Preset ${preset.name} (${preset.provider}/${preset.model}) configured`,
    });
  });

  return app;
}
