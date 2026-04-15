/**
 * Miscellaneous API routes — presets, packages, commands, block-schemas, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import fs from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { Hono } from 'hono';
import type { AiStack } from '../ai-setup.js';
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  loadPluginSummary,
  type PluginRegistry,
  type PluginDiscoveryResult,
} from '@covel/plugin-loader';
import type { DataStore } from '@covel/store';

type FlowSegmentId =
  | 'start'
  | 'pre-game'
  | 'pre-narrator'
  | 'narrator'
  | 'post-narrator';
type UiSlotName = 'right' | 'message' | 'left';

const UI_NAMESPACE_BY_SLOT: Record<UiSlotName, string> = {
  right: '__ui_right__',
  message: '__ui_message__',
  left: '__ui_left__',
};

function resolvePluginsDir(): string {
  return process.env.COVEL_PLUGINS_DIR
    ?? resolve(import.meta.dirname, '../../../../plugins');
}

function textValue(value: unknown, locale = 'zh-CN'): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, string>;
    return record[locale] ?? record['en-US'] ?? Object.values(record)[0] ?? '';
  }
  return '';
}

function segmentForPriority(priority: number): FlowSegmentId {
  if (priority <= 0) return 'start';
  if (priority <= 100) return 'pre-game';
  if (priority < 500) return 'pre-narrator';
  if (priority === 500) return 'narrator';
  return 'post-narrator';
}

function docPathFromAbsolute(pluginsDir: string, absolutePath: string): string {
  return `plugins/${relative(pluginsDir, absolutePath).replace(/\\/g, '/')}`;
}

function uiSlotsOf(manifest: {
  ui?: {
    right?: readonly string[];
    message?: readonly string[];
    left?: readonly string[];
  };
}): string[] {
  const slots: string[] = [];
  if (manifest.ui?.right?.length) slots.push('right');
  if (manifest.ui?.message?.length) slots.push('message');
  if (manifest.ui?.left?.length) slots.push('left');
  return slots;
}

function isStoryRuntime(manifest: {
  outputKind?: string;
  capabilities?: readonly string[];
}): boolean {
  return manifest.outputKind === 'story' || manifest.capabilities?.includes('narrative') === true;
}

async function loadPluginDiscovery(pluginId: string): Promise<PluginDiscoveryResult | undefined> {
  const pluginsDir = resolvePluginsDir();
  const discoveries = await discoverPlugins(pluginsDir);
  return discoveries.find((item) => item.id === pluginId);
}

async function buildPluginFlowResponse() {
  const pluginsDir = resolvePluginsDir();
  const discoveries = await discoverPlugins(pluginsDir);

  const plugins: Array<{
    id: string;
    name: string;
    description: string;
    pluginType: string;
    runtimeIds: string[];
  }> = [];

  const steps: Array<{
    id: string;
    pluginId: string;
    pluginName: string;
    runtimeId: string;
    runtimeName: string;
    description: string;
    pluginType: string;
    priority: number;
    segmentId: FlowSegmentId;
    runtimeType: string;
    outputKind: string;
    model?: string;
    trigger: {
      type: string;
      interval?: number;
      cooldownTurns?: number;
      maxTriggerCount?: number;
      phases: string[];
      startTurn?: number;
    };
    injects: Array<{ from: string; field: string; as: string }>;
    tools: { builtin: string[]; local: string[] };
    uiSlots: string[];
    docPath: string;
    isStoryRuntime: boolean;
  }> = [];

  for (const discovery of discoveries) {
    const [summary, manifests] = await Promise.all([
      loadPluginSummary(discovery),
      loadPluginManifest(discovery),
    ]);

    const pluginName = textValue(summary.name) || discovery.id;
    const pluginDescription = textValue(summary.description);

    plugins.push({
      id: discovery.id,
      name: pluginName,
      description: pluginDescription,
      pluginType: summary.pluginType,
      runtimeIds: manifests.map((item) => item.manifest.name),
    });

    for (const [index, parsed] of manifests.entries()) {
      const manifest = parsed.manifest;
      const runtimeId = manifest.name;
      const runtimeName = runtimeId.includes('/') ? runtimeId.split('/').at(-1) ?? runtimeId : runtimeId;
      const priority = manifest.priority ?? 500;
      const mdPath = discovery.pluginMdPaths[index] ?? discovery.pluginMdPaths[0];
      const docPath = mdPath ? docPathFromAbsolute(pluginsDir, mdPath) : ''

      steps.push({
        id: runtimeId,
        pluginId: discovery.id,
        pluginName,
        runtimeId,
        runtimeName,
        description: textValue(manifest.description),
        pluginType: summary.pluginType,
        priority,
        segmentId: segmentForPriority(priority),
        runtimeType: manifest.runtimeType ?? 'agent',
        outputKind: manifest.outputKind ?? 'plugin',
        model: manifest.model,
        trigger: {
          type: manifest.trigger?.type ?? 'auto',
          interval: manifest.trigger?.interval,
          cooldownTurns: manifest.trigger?.cooldownTurns,
          maxTriggerCount: manifest.trigger?.maxTriggerCount,
          phases: [...(manifest.trigger?.phases ?? [])],
          startTurn: manifest.trigger?.startTurn,
        },
        injects: (manifest.input?.inject ?? []).map((inject) => ({
          from: inject.from,
          field: inject.field,
          as: inject.as,
        })),
        tools: {
          builtin: [...(manifest.tools?.builtin ?? [])],
          local: [...(manifest.tools?.local ?? [])].map((toolPath) => {
            const fileName = toolPath.split('/').at(-1) ?? toolPath;
            return fileName.replace(/\.[^.]+$/, '');
          }),
        },
        uiSlots: uiSlotsOf(manifest),
        docPath,
        isStoryRuntime: isStoryRuntime(manifest),
      });
    }
  }

  steps.sort((a, b) => a.priority - b.priority || a.runtimeId.localeCompare(b.runtimeId));
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: 'v1',
    generatedAt: new Date().toISOString(),
    segments: [
      { id: 'start', label: '开始游戏', rangeLabel: '0', minPriority: 0, maxPriority: 0 },
      { id: 'pre-game', label: 'Pre-Game', rangeLabel: '1-100', minPriority: 1, maxPriority: 100 },
      { id: 'pre-narrator', label: 'Pre-Narrator', rangeLabel: '101-499', minPriority: 101, maxPriority: 499 },
      { id: 'narrator', label: 'Narrator', rangeLabel: '500', minPriority: 500, maxPriority: 500 },
      { id: 'post-narrator', label: 'Post-Narrator', rangeLabel: '501-1000', minPriority: 501, maxPriority: 1000 },
    ],
    plugins,
    steps,
  };
}

async function loadLivePluginMaps() {
  const pluginsDir = resolvePluginsDir();
  const discoveries = await discoverPlugins(pluginsDir);
  const summaryMap = new Map<string, Awaited<ReturnType<typeof loadPluginSummary>>>();
  const manifestMap = new Map<string, Awaited<ReturnType<typeof loadPluginManifest>>>();

  await Promise.all(
    discoveries.map(async (discovery) => {
      const [summary, manifests] = await Promise.all([
        loadPluginSummary(discovery),
        loadPluginManifest(discovery),
      ]);
      summaryMap.set(discovery.id, summary);
      manifestMap.set(discovery.id, manifests);
    }),
  );

  return { summaryMap, manifestMap };
}

async function syncUiSpecsToStore(
  sessionId: string,
  activePluginIds: ReadonlySet<string>,
  store: DataStore,
): Promise<void> {
  const pluginsDir = resolvePluginsDir();
  const discoveries = await discoverPlugins(pluginsDir);
  const now = new Date().toISOString();
  const writes: Array<{
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }> = [];

  for (const discovery of discoveries) {
    if (!activePluginIds.has(discovery.id)) continue;

    const manifests = await loadPluginManifest(discovery);

    // Clear old cached specs for this plugin so hot-reloads don't leave stale blocks behind.
    for (const namespace of Object.values(UI_NAMESPACE_BY_SLOT)) {
      const existing = await store.listPluginData(sessionId, discovery.id, namespace);
      for (const row of existing) {
        await store.deletePluginData(sessionId, discovery.id, namespace, row.key);
      }
    }

    for (const [runtimeIndex, parsed] of manifests.entries()) {
      const loaded = await loadRuntime(discovery, parsed.manifest.name);
      if (!loaded.uiSpecs) continue;

      for (const slot of Object.keys(UI_NAMESPACE_BY_SLOT) as UiSlotName[]) {
        const specs = loaded.uiSpecs[slot];
        if (!specs || specs.length === 0) continue;
        writes.push({
          id: crypto.randomUUID(),
          sessionId,
          pluginId: discovery.id,
          namespace: UI_NAMESPACE_BY_SLOT[slot],
          key: `${String(runtimeIndex).padStart(3, '0')}:${loaded.manifest.name}`,
          value: specs,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (writes.length > 0) {
    await store.setPluginDataBatch(writes);
  }
}

export function createMiscApiRoutes(
  ai: AiStack,
  registry: PluginRegistry,
  store: DataStore,
): Hono {
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
  app.get('/api/packages', async (c) => {
    const all = registry.getAll();
    const { summaryMap, manifestMap } = await loadLivePluginMaps();
    const packages: Array<Record<string, unknown>> = [];
    const loadErrors: Array<{ pluginId: string; errors: string[] }> = [];

    for (const [, entry] of all) {
      if (entry.status === 'error' && entry.error) {
        loadErrors.push({ pluginId: entry.id, errors: [entry.error] });
        continue;
      }

      const liveSummary = summaryMap.get(entry.id) ?? entry.summary;
      const liveManifests = manifestMap.get(entry.id) ?? (entry.manifests ?? (entry.manifest ? [entry.manifest] : []));

      const runtimes = liveManifests.map((m) => ({
        id: m.manifest.name,
        kind: m.manifest.runtimeType ?? 'agent',
        priority: m.manifest.priority ?? 500,
        trigger: m.manifest.trigger ?? { mode: 'always' },
      }));

      const tools = liveManifests
        .flatMap((m) => [
          ...(m.manifest.tools?.builtin ?? []).map((t) => ({ id: t, kind: 'builtin' })),
          ...(m.manifest.tools?.local ?? []).map((t) => {
            const basename = t.split('/').pop()?.replace(/\.[^.]+$/, '') ?? t;
            return { id: basename, kind: 'local' };
          }),
        ]);

      packages.push({
        name: entry.id,
        displayName: textValue(liveSummary.name),
        description: textValue(liveSummary.description),
        pluginType: liveSummary.pluginType,
        enabled: true,
        runtimes,
        tools,
      });
    }

    return c.json({ packages, loadErrors });
  });

  // GET /api/plugin-flows — framework-orchestrated flow data for pre-game preview
  app.get('/api/plugin-flows', async (c) => {
    const payload = await buildPluginFlowResponse();
    return c.json(payload);
  });

  // GET /api/plugin-docs/:pluginId — raw PLUGIN.md documents for preview
  app.get('/api/plugin-docs/:pluginId', async (c) => {
    const pluginId = c.req.param('pluginId');
    const discovery = await loadPluginDiscovery(pluginId);
    if (!discovery) {
      return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    }

    const pluginsDir = resolvePluginsDir();
    const [summary, manifests] = await Promise.all([
      loadPluginSummary(discovery),
      loadPluginManifest(discovery),
    ]);

    const docs = await Promise.all(
      discovery.pluginMdPaths.map(async (mdPath, index) => ({
        id: manifests[index]?.manifest.name ?? `${pluginId}:${index}`,
        runtimeId: manifests[index]?.manifest.name ?? `${pluginId}:${index}`,
        label: manifests[index]?.manifest.name ?? pluginId,
        path: docPathFromAbsolute(pluginsDir, mdPath),
        content: await fs.readFile(mdPath, 'utf-8'),
      })),
    );

    return c.json({
      pluginId,
      name: textValue(summary.name) || pluginId,
      docs,
    });
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

  // GET /api/ui-specs — list UI specs from plugin manifests, grouped by slot.
  // When ?sessionId= is provided, filter to that session's activePlugins so the
  // panel only shows plugins actually enabled for the current session.
  // (Audit Finding w2 — without this, RightPanel shows specs for plugins that
  // are loaded globally but not enabled for the active session.)
  app.get('/api/ui-specs', async (c) => {
    type SlotEntry = { pluginId: string; specs: readonly Record<string, unknown>[] };
    const right: SlotEntry[] = [];
    const message: SlotEntry[] = [];
    const left: SlotEntry[] = [];

    const sessionId = c.req.query('sessionId');
    let activeFilter: Set<string> | null = null;
    if (sessionId) {
      const session = await store.getSession(sessionId);
      if (session) {
        activeFilter = new Set(session.activePlugins ?? []);
        await syncUiSpecsToStore(sessionId, activeFilter, store);
      }
    }

    if (sessionId && activeFilter) {
      for (const pluginId of activeFilter) {
        const [rightRows, messageRows, leftRows] = await Promise.all([
          store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.right),
          store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.message),
          store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.left),
        ]);

        const toSpecs = (rows: typeof rightRows) =>
          rows
            .sort((a, b) => a.key.localeCompare(b.key))
            .flatMap((row) => Array.isArray(row.value) ? row.value as Record<string, unknown>[] : []);

        const rightSpecs = toSpecs(rightRows);
        const messageSpecs = toSpecs(messageRows);
        const leftSpecs = toSpecs(leftRows);

        if (rightSpecs.length) right.push({ pluginId, specs: rightSpecs });
        if (messageSpecs.length) message.push({ pluginId, specs: messageSpecs });
        if (leftSpecs.length) left.push({ pluginId, specs: leftSpecs });
      }
    } else {
      const all = registry.getAll();
      for (const [, entry] of all) {
        if (entry.status === 'error') continue;
        if (activeFilter && !activeFilter.has(entry.id)) continue;

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
