/**
 * Miscellaneous API routes — presets, packages, commands, block-schemas, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import fs from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { Hono } from 'hono';
import { readEnvString, readRuntimeEnv } from '@covel/shared';
import type { AiStack } from '../ai-setup.js';
import { applySlotOverlay, type SlotOverridesInput } from '@covel/ai-provider';
import {
  discoverPluginsMulti,
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

/**
 * All plugin directories the server should scan — bundled first, user
 * install dir second. Mirrors `apps/server/src/app.ts:199` so `/api/ui-specs`
 * and sibling endpoints see the same plugin set the kernel bootstrapped
 * against. Without this, user-installed plugins (e.g. ~/.covel/plugins/*)
 * never get their UI specs materialised into `plugin_data.__ui_right__`
 * and the frontend right panel silently drops their buttons.
 */
function resolvePluginsDirs(): readonly string[] {
  const env = readRuntimeEnv();
  const bundled = env.pluginsDir
    ?? resolve(import.meta.dirname, '../../../../plugins');
  const dirs = [bundled];
  if (env.userPluginsDir && env.userPluginsDir !== bundled) {
    dirs.push(env.userPluginsDir);
  }
  return dirs;
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
  // audit P0-1: align with packages/runtime/src/scheduler.ts band edges.
  // Pre-Game is `0-99` (turn 0 only), main loop is `100-1000`. Treating
  // `priority === 100` as Pre-Game would put it in the wrong band on the
  // flow viz — same drift the audit calls out.
  if (priority <= 0) return 'start';
  if (priority <= 99) return 'pre-game';
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
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
  return discoveries.find((item) => item.id === pluginId);
}

async function buildPluginFlowResponse() {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());

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
      startTurn?: number;
    };
    injects: Array<{ kind: string; as: string; from?: string; field?: string; namespace?: string; format?: string }>;
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
      const discoveryRoot = resolve(discovery.rootPath, '..');
      const docPath = mdPath ? docPathFromAbsolute(discoveryRoot, mdPath) : ''

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
          startTurn: manifest.trigger?.startTurn,
        },
        injects: (manifest.input?.inject ?? []).map((inject) => ({
          kind: inject.kind,
          ...(inject.kind === 'runtime'
            ? { from: inject.from, field: inject.field }
            : { namespace: inject.namespace, format: inject.format }),
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
      { id: 'pre-game', label: 'Pre-Game', rangeLabel: '1-99', minPriority: 1, maxPriority: 99 },
      { id: 'pre-narrator', label: 'Pre-Narrator', rangeLabel: '100-499', minPriority: 100, maxPriority: 499 },
      { id: 'narrator', label: 'Narrator', rangeLabel: '500', minPriority: 500, maxPriority: 500 },
      { id: 'post-narrator', label: 'Post-Narrator', rangeLabel: '501-1000', minPriority: 501, maxPriority: 1000 },
    ],
    plugins,
    steps,
  };
}

async function loadLivePluginMaps() {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
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
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
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
  //
  // Each entry carries enough info for the settings UI to identify exactly
  // what a Ping would hit:
  //   - `baseUrl`: preset-level override, else the provider default
  //   - `protocol`: preset-level protocol, else the provider default
  //   - `slotBindings`: every slot id whose `presetId` resolves here — lets
  //     the UI show e.g. `default, fast` next to the preset so operators can
  //     tell which aliases share a single underlying model.
  app.get('/api/presets', (c) => {
    const slotMap = ai.slotRegistry.listSlots();
    const slotBindingsByPreset = new Map<string, string[]>();
    for (const [slotId, slot] of Object.entries(slotMap)) {
      const list = slotBindingsByPreset.get(slot.presetId) ?? [];
      list.push(slotId);
      slotBindingsByPreset.set(slot.presetId, list);
    }

    const presets = ai.presetRegistry.listPresets().map((p) => {
      // Fall back to the provider's registered default baseUrl/protocol
      // when the preset itself doesn't override them. `resolve` never
      // throws for a known provider; unknown providers return null here.
      let providerBaseUrl: string | undefined;
      let providerProtocol: string | undefined;
      try {
        const resolution = ai.providerRegistry.resolve({ provider: p.provider });
        providerBaseUrl = resolution.config.baseUrl;
        providerProtocol = resolution.protocol;
      } catch {
        // Unknown provider — leave both undefined; the UI will show "-"
      }

      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        model: p.model,
        enabled: p.enabled,
        isDefault: p.isDefault ?? false,
        scope: 'global',
        baseUrl: p.baseUrl ?? providerBaseUrl,
        protocol: p.protocol ?? providerProtocol,
        slotBindings: slotBindingsByPreset.get(p.id) ?? [],
      };
    });
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

      // Aggregate userSettings across every runtime of this plugin so the
      // frontend Settings UI can render them under "Plugins > <pluginId>".
      const userSettings = liveManifests.flatMap((m) =>
        (m.manifest.userSettings ?? []).map((spec) => ({ ...spec })),
      );

      packages.push({
        name: entry.id,
        displayName: textValue(liveSummary.name),
        description: textValue(liveSummary.description),
        pluginType: liveSummary.pluginType,
        enabled: true,
        runtimes,
        tools,
        ...(userSettings.length > 0 ? { userSettings } : {}),
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

    // Root-of-origin is the plugin's own discovered root, not the bundled
    // plugins dir — this keeps relative paths correct for user-installed
    // plugins that live under ~/.covel/plugins rather than the app bundle.
    const pluginsDir = resolve(discovery.rootPath, '..');
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
      const fallbackPresetId = preset.fallbackPresetIds?.[0];
      const fallbackSlotId =
        typeof fallbackPresetId === 'string'
          ? (fallbackPresetId.startsWith('slot-')
              ? fallbackPresetId.slice('slot-'.length)
              : fallbackPresetId)
          : undefined;
      slotsInfo[slotId] = {
        provider: preset.provider,
        model: preset.model,
        protocol: preset.protocol ?? 'openai-chat-v1',
        tag: slot.tag,
        ...(fallbackSlotId ? { fallback: fallbackSlotId } : {}),
        ...(preset.capability ? { capability: preset.capability } : {}),
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
    const KNOWN_PROVIDERS = ['DEEPSEEK', 'DASHSCOPE', 'OPENAI', 'ANTHROPIC', 'OPENROUTER'] as const;

    // Security: allowlist approach — expose raw keys only for local self-tier
    // requests so the onboarding UI can hydrate provider settings.
    // All other cases return provider availability booleans + masked metadata.
    const tier = readRuntimeEnv().deploymentTier;
    const host = new URL(c.req.url).hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const allowRawKeys = (tier === 'T1' || tier === 'self') && isLocalhost;

    if (allowRawKeys) {
      const keys: Record<string, string> = {};
      for (const provider of KNOWN_PROVIDERS) {
        const envKey = `${provider}_API_KEY`;
        const value = readEnvString(envKey);
        if (value) keys[provider.toLowerCase()] = value;
      }
      return c.json({ keys });
    }

    // Non-T1 or non-localhost: return availability + masked metadata only
    const providers: Record<string, { configured: boolean; masked: string }> = {};
    for (const provider of KNOWN_PROVIDERS) {
      const envKey = `${provider}_API_KEY`;
      const value = readEnvString(envKey);
      if (value) {
        const masked = value.length > 8
          ? `${value.slice(0, 4)}...${value.slice(-4)}`
          : '****';
        providers[provider.toLowerCase()] = { configured: true, masked };
      }
    }
    return c.json({ keys: {}, providers });
  });

  // POST /api/ai/ping — real provider latency probe.
  //
  // Streams a minimal "hi" completion and records time-to-first-token
  // (TTFB) against the first non-empty `text-delta` or `reasoning-delta`
  // event (so "thinking" models are measured on their first reasoning
  // character, not the first visible text token).
  //
  // The stream is aborted shortly after the first content arrives to keep
  // the probe cheap — we only care about connectivity + latency, not the
  // full reply.
  app.post('/api/ai/ping', async (c) => {
    const body = await c.req
      .json<{ presetId?: string; slot?: string }>()
      .catch((): { presetId?: string; slot?: string } => ({}));
    const requested = body.presetId ?? (body.slot ? `slot-${body.slot}` : 'slot-default');

    // Decode per-request API keys (base64 JSON). Keys are never persisted server-side.
    let apiKeys: Record<string, string> | undefined;
    const keysHeader = c.req.header('X-Provider-Keys');
    if (keysHeader) {
      try {
        const decoded = Buffer.from(keysHeader, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') apiKeys = parsed as Record<string, string>;
      } catch {
        // Fall through — let gateway raise a clearer error if the key is actually needed.
      }
    }

    // Decode the client slot config header (base64 JSON). Shared with the
    // turn pipeline's per-request middleware — the ping endpoint needs its
    // own decode because ping can be called before the per-request
    // middleware runs (same request, but the resolution we do here happens
    // against the already-mutated registries).
    let slotConfig: SlotOverridesInput = {};
    const slotHeader = c.req.header('X-Slot-Config');
    if (slotHeader) {
      try {
        const decoded = Buffer.from(slotHeader, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') slotConfig = parsed as SlotOverridesInput;
      } catch {
        // Malformed header — behave as if no overrides were supplied.
      }
    }

    // Register client-declared custom presets + providers via the shared
    // overlay helper (ref-counted, base-registry-safe).
    const cleanupTransient = applySlotOverlay(ai, slotConfig);

    const allPresets = ai.presetRegistry.listPresets().filter((p) => p.enabled);

    // Resolution chain:
    //   1. Direct preset id match (includes overlay-registered ones)
    //   2. `slot-<name>` → client slotPresetOverrides → slotRegistry
    //   3. Text-tag fallback (mirrors gateway.streamText behaviour)
    //   4. Any enabled preset
    //
    // `resolvedVia` is echoed back in `testedTarget` so the UI can warn
    // when a slot Ping silently fell through to a tag-fallback preset
    // (i.e. the slot the user typed isn't actually configured).
    type ResolvedVia = 'direct' | 'slot' | 'tag-fallback' | 'any';
    let resolvedVia: ResolvedVia = 'direct';
    let preset = allPresets.find((p) => p.id === requested);
    if (!preset && requested.startsWith('slot-')) {
      const slotName = requested.slice('slot-'.length);
      const overrideId = slotConfig.slotPresetOverrides?.[slotName];
      if (overrideId) {
        preset = allPresets.find((p) => p.id === overrideId);
        if (preset) resolvedVia = 'slot';
      }
      if (!preset) {
        const presetIdFromSlot = ai.slotRegistry.resolveSlot(slotName);
        if (presetIdFromSlot) {
          preset = allPresets.find((p) => p.id === presetIdFromSlot);
          if (preset) resolvedVia = 'slot';
        }
      }
    }
    if (!preset) {
      const textSlots = ai.slotRegistry.listSlotsByTag('text');
      if (textSlots.length > 0) {
        preset = allPresets.find((p) => p.id === textSlots[0].presetId);
        if (preset) resolvedVia = 'tag-fallback';
      }
    }
    if (!preset) {
      preset = allPresets[0];
      if (preset) resolvedVia = 'any';
    }

    if (!preset) {
      cleanupTransient();
      return c.json({
        ok: false,
        latencyMs: 0,
        error: 'No LLM provider configured. Add a slot to llm.toml or via Settings.',
      });
    }

    // Resolve the effective baseUrl/protocol once so error + success paths
    // both report the exact target. Unknown providers can still ping via
    // the preset's own baseUrl, so treat resolution failure as non-fatal.
    let effectiveBaseUrl = preset.baseUrl;
    let effectiveProtocol: string | undefined = preset.protocol;
    try {
      const resolution = ai.providerRegistry.resolve({
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        protocol: preset.protocol,
      });
      effectiveBaseUrl = resolution.config.baseUrl ?? preset.baseUrl;
      effectiveProtocol = resolution.protocol;
    } catch {
      // Provider not registered — fall back to preset fields as-is.
    }

    const testedTarget = {
      presetId: preset.id,
      provider: preset.provider,
      model: preset.model,
      baseUrl: effectiveBaseUrl,
      protocol: effectiveProtocol,
      resolvedVia,
    };

    const startedAt = Date.now();
    let ttfbMs: number | null = null;
    let firstText = '';
    let finalUsage: { inputTokens: number; outputTokens: number } | null = null;
    const abort = new AbortController();
    let aborted = false;
    let timedOut = false;

    // Safety timeout — a ping that can't even start streaming within 30s is
    // effectively broken. Without this the endpoint would hang indefinitely
    // on misconfigured providers (wrong baseUrl, unreachable host, ...).
    const timeout = setTimeout(() => {
      if (!aborted) {
        timedOut = true;
        aborted = true;
        abort.abort();
      }
    }, 30_000);

    try {
      for await (const event of ai.gateway.streamText(
        { presetId: preset.id, messages: [{ role: 'user', content: 'hi' }] },
        {
          apiKeys,
          signal: abort.signal,
          slotOverrides: {
            ...(slotConfig.slotPresetOverrides
              ? { slotPresetOverrides: slotConfig.slotPresetOverrides }
              : {}),
            ...(slotConfig.parameterOverrides
              ? { parameterOverrides: slotConfig.parameterOverrides }
              : {}),
          },
        },
      )) {
        if (event.type === 'text-delta' && event.textDelta.length > 0) {
          if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
          firstText += event.textDelta;
          // Stop once we have proof-of-life; keeps probe cheap (~1 token).
          if (firstText.length >= 8 && !aborted) {
            aborted = true;
            abort.abort();
          }
        } else if (event.type === 'reasoning-delta' && event.reasoningDelta.length > 0) {
          if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
        } else if (event.type === 'done') {
          finalUsage = event.usage;
        }
      }
    } catch (err) {
      if (!aborted) {
        const message = err instanceof Error ? err.message : String(err);
        clearTimeout(timeout);
        cleanupTransient();
        return c.json({
          ok: false,
          latencyMs: Date.now() - startedAt,
          ...(ttfbMs !== null ? { ttfbMs } : {}),
          error: message,
          testedTarget,
        });
      }
      // Deliberate abort — either a post-TTFB early-stop or our 30s timeout.
    }

    clearTimeout(timeout);
    cleanupTransient();
    const latencyMs = Date.now() - startedAt;
    if (ttfbMs === null) {
      return c.json({
        ok: false,
        latencyMs,
        error: timedOut
          ? 'Provider did not return any content within 30s'
          : 'Provider returned no content',
        testedTarget,
      });
    }

    return c.json({
      ok: true,
      latencyMs,
      ttfbMs,
      text: `${preset.name} (${preset.provider}/${preset.model})`,
      ...(finalUsage ? { usage: finalUsage } : {}),
      testedTarget,
    });
  });

  return app;
}
