/**
 * V1 compatibility routes — frontend still uses V1-style paths.
 *
 * These proxy to V2 handlers. Remove when frontend is fully migrated to V2 paths.
 */

import { Hono } from 'hono';
import type { V2BootstrapResult } from './v2/bootstrap.js';
import type { AiStack } from '../ai-setup.js';

export function createV1CompatRoutes(v2: V2BootstrapResult, ai: AiStack): Hono {
  const app = new Hono();

  // ── Simple proxies ────────────────────────────────────────────────

  app.get('/api/health', async (c) => {
    const res = await v2.app.request('/v2/health');
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.get('/worlds', async (c) => {
    const res = await v2.app.request('/v2/worlds');
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.get('/worlds/:id', async (c) => {
    const res = await v2.app.request(`/v2/worlds/${c.req.param('id')}`);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.patch('/worlds/:id', async (c) => {
    const body = await c.req.text();
    const res = await v2.app.request(`/v2/worlds/${c.req.param('id')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.get('/sessions', async (c) => {
    const res = await v2.app.request('/v2/sessions');
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // ── Session create (enriches with auto-activated plugins) ─────────

  app.post('/sessions', async (c) => {
    const rawBody = await c.req.json<Record<string, unknown>>();
    const allPluginIds = [...v2.registry.getAll().keys()];
    const enriched = {
      ...rawBody,
      plugins: rawBody.plugins ?? allPluginIds,
      locale: rawBody.locale ?? 'zh-CN',
    };
    const res = await v2.app.request('/v2/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched),
    });
    if (!res.ok) {
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    const v2Data = await res.json() as Record<string, unknown>;
    return c.json({
      id: v2Data.sessionId,
      worldId: rawBody.worldId ?? null,
      status: 'active',
      phase: v2Data.phase ?? 'pre-game',
      presetId: rawBody.presetId ?? null,
      createdAt: new Date().toISOString(),
    });
  });

  // ── Session sub-routes ────────────────────────────────────────────

  app.get('/sessions/:id', async (c) => {
    const res = await v2.app.request(`/v2/session/${c.req.param('id')}`);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.delete('/sessions/:id', async (c) => {
    const res = await v2.app.request(`/v2/session/${c.req.param('id')}`, { method: 'DELETE' });
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.patch('/sessions/:id', async (c) => {
    const body = await c.req.text();
    const res = await v2.app.request(`/v2/session/${c.req.param('id')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // ── Session plugin management ─────────────────────────────────────

  app.get('/sessions/:id/plugins', async (c) => {
    const id = c.req.param('id');
    const session = await v2.store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const allPlugins = v2.registry.getAll();
    const activeSet = new Set(session.activePlugins);
    const available = [...allPlugins.values()].map((entry) => {
      const m = entry.manifest?.manifest;
      return {
        id: entry.id,
        displayName: entry.summary.name,
        description: entry.summary.description,
        isActive: activeSet.has(entry.id),
        locked: entry.summary.pluginType === 'core-plugin',
        pluginType: entry.summary.pluginType,
        status: entry.status,
        error: entry.error,
        priority: m?.priority,
        runtimeType: m?.runtimeType ?? 'agent',
        model: m?.model,
        trigger: m?.trigger,
        outputKind: m?.outputKind,
        capabilities: m?.capabilities ?? [],
        tools: {
          builtin: m?.tools?.builtin ?? [],
          local: (m?.tools?.local ?? []).map((p: string) => p.split('/').pop()?.replace(/\.[^.]+$/, '') ?? p),
        },
        config: m?.config ?? {},
      };
    });
    return c.json({
      active: [...session.activePlugins],
      available,
    });
  });

  app.post('/sessions/:id/plugins/enable', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = body.pluginId;
    if (typeof pluginId !== 'string' || !pluginId) {
      return c.json({ error: 'pluginId must be a non-empty string' }, 400);
    }
    const session = await v2.store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!v2.registry.get(pluginId)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }
    const activeSet = new Set(session.activePlugins);
    if (!activeSet.has(pluginId)) {
      activeSet.add(pluginId);
      await v2.store.updateSession(id, { activePlugins: [...activeSet] });
      v2.registry.activate(pluginId, id);
    }
    return c.json({ ok: true, activePlugins: [...activeSet] });
  });

  app.post('/sessions/:id/plugins/disable', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = body.pluginId;
    if (typeof pluginId !== 'string' || !pluginId) {
      return c.json({ error: 'pluginId must be a non-empty string' }, 400);
    }
    const session = await v2.store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const entry = v2.registry.get(pluginId);
    if (entry && entry.summary.pluginType === 'core-plugin') {
      return c.json({ error: 'Cannot disable core plugin' }, 403);
    }
    const activeSet = new Set(session.activePlugins);
    if (activeSet.has(pluginId)) {
      activeSet.delete(pluginId);
      await v2.store.updateSession(id, { activePlugins: [...activeSet] });
      v2.registry.deactivate(pluginId, id);
    }
    return c.json({ ok: true, activePlugins: [...activeSet] });
  });

  // ── SSE compat ────────────────────────────────────────────────────

  app.get('/events/stream', async (c) => {
    const url = new URL(c.req.url);
    const v2Url = `/v2/events/stream${url.search}`;
    const res = await v2.app.request(v2Url);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // ── Stubs for V1 endpoints with no V2 equivalent ──────────────────

  app.get('/presets', (c) => c.json([]));
  app.get('/packages', (c) => {
    const allPlugins = v2.registry.getAll();
    const packages = [...allPlugins.values()]
      .filter((entry) => entry.status !== 'error')
      .map((entry) => {
        const allManifests = entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
        const allTools: Array<{ id: string; kind: string }> = [];
        for (const parsed of allManifests) {
          const m = parsed.manifest;
          for (const t of m.tools?.builtin ?? []) allTools.push({ id: t, kind: 'builtin' });
          for (const t of m.tools?.local ?? []) allTools.push({
            id: t.split('/').pop()?.replace(/\.[^.]+$/, '') ?? t,
            kind: 'local',
          });
        }
        return {
          name: entry.id,
          displayName: entry.summary.name,
          description: entry.summary.description,
          enabled: true,
          version: allManifests[0]?.manifest.version,
          runtimes: allManifests.map((parsed) => {
            const m = parsed.manifest;
            return {
              id: m.name,
              kind: m.outputKind ?? 'plugin',
              priority: m.priority,
              trigger: { mode: m.trigger?.type ?? 'auto' },
              providerTag: m.runtimeType === 'function' ? undefined : (m.model ?? 'text'),
            };
          }),
          tools: allTools,
        };
      });
    const loadErrors = [...allPlugins.values()]
      .filter((entry) => entry.status === 'error')
      .map((entry) => ({
        pluginId: entry.id,
        errors: [entry.error ?? 'Unknown error'],
      }));
    return c.json({ packages, loadErrors });
  });
  app.get('/commands', (c) => c.json([]));
  app.get('/api/llm-config', (c) => {
    const slots = ai.slotRegistry.listSlots();
    const presets = ai.presetRegistry.listPresets();

    const slotInfo: Record<string, { presetId: string; provider: string; model: string; protocol: string }> = {};
    const providerSet = new Set<string>();

    for (const [slotId, slot] of Object.entries(slots)) {
      const preset = presets.find((p) => p.id === slot.presetId);
      const provider = preset?.provider ?? 'unknown';
      const model = preset?.model ?? 'unknown';
      const protocol = preset?.protocol ?? 'openai-chat';
      slotInfo[slotId] = { presetId: slot.presetId, provider, model, protocol };
      providerSet.add(provider);
    }

    return c.json({
      configured: Object.keys(slots).length > 0,
      slots: slotInfo,
      providers: [...providerSet],
    });
  });
  app.get('/api/provider-keys', (c) => c.json({}));
  app.post('/api/provider-keys', (c) => c.json({ ok: true }));
  app.get('/sessions/:id/state-patches', (c) => c.json([]));
  app.get('/sessions/:id/state-snapshot', (c) => c.json(null));
  app.put('/sessions/:id/state-snapshot', (c) => c.json({ ok: true }));

  return app;
}
