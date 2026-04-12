/**
 * Resume route — resumes a suspended runtime (S4-T4).
 *
 * POST /api/sessions/:id/resume
 *   Body: { suspensionId: string, data: unknown }
 *
 * Requires COVEL_SUSPEND_V1=1 to be active — returns 503 when flag is off.
 *
 * API keys are NEVER stored server-side; they must be supplied again via
 * the `X-Provider-Keys` header on this request (same as any turn call).
 *
 * TODO(S4-T4.c): Suspension expiration / TTL cleanup is not implemented.
 * Open suspensions remain until explicitly resumed or deleted. A future
 * ticket should add a background job to expire stale suspensions.
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import { resumeSuspendedRuntime } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    getConfigFn: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
    resolveModel: (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;
  };
};

export const resumeRoutes = new Hono<Env>();

// ── Minimal JSON Schema validator (no new deps) ──────────────────
//
// Validates `data` against a plain JSON Schema { type, properties, required }.
// Returns null on success, error string on failure.
function validateAgainstJsonSchema(data: unknown, schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null; // no schema = no validation

  const s = schema as Record<string, unknown>;

  // type check
  if (s['type'] !== undefined) {
    const expectedType = s['type'] as string;
    const actualType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    if (actualType !== expectedType) {
      return `Expected type "${expectedType}", got "${actualType}"`;
    }
  }

  // required fields
  if (Array.isArray(s['required']) && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const field of s['required'] as string[]) {
      if (!(field in obj)) {
        return `Missing required field: "${field}"`;
      }
    }
  }

  // properties type-check (shallow — one level deep is sufficient for resume schemas)
  if (s['properties'] && typeof s['properties'] === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const props = s['properties'] as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && propSchema['type'] !== undefined) {
        const val = obj[key];
        const expectedType = propSchema['type'] as string;
        const actualType = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== expectedType) {
          return `Field "${key}": expected type "${expectedType}", got "${actualType}"`;
        }
      }
    }
  }

  return null;
}

// ── Route ────────────────────────────────────────────────────────

resumeRoutes.post('/:id/resume', async (c) => {
  // Feature flag check — 503 when flag off (documented choice: 503 Service Unavailable
  // indicates the endpoint exists but the feature is disabled, distinct from 404 Not Found)
  if (process.env['COVEL_SUSPEND_V1'] !== '1') {
    return c.json({ error: 'Suspend/resume feature is not enabled (COVEL_SUSPEND_V1)' }, 503);
  }

  const sessionId = c.req.param('id');
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const llmAdapter = c.get('llmAdapter');
  const loadRuntimeFn = c.get('loadRuntimeFn');
  const toolExecutor = c.get('toolExecutor');
  const resolveModel = c.get('resolveModel');

  // Require provider keys header — API keys are never stored
  const providerKeysHeader = c.req.header('X-Provider-Keys');
  if (!providerKeysHeader) {
    return c.json({ error: 'Missing X-Provider-Keys header (provider API keys are not stored server-side)' }, 400);
  }

  let body: { suspensionId?: unknown; data?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { suspensionId, data } = body;
  if (!suspensionId || typeof suspensionId !== 'string') {
    return c.json({ error: 'suspensionId is required' }, 400);
  }

  // Verify session exists
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Load suspension
  const suspension = await store.getSuspension(suspensionId);
  if (!suspension) {
    return c.json({ error: 'Suspension not found' }, 404);
  }
  if (suspension.sessionId !== sessionId) {
    return c.json({ error: 'Suspension not found' }, 404);
  }
  if (suspension.resolvedAt) {
    return c.json({ error: 'Suspension already resolved' }, 404);
  }

  // Validate resume data against stored resumeSchema
  const validationError = validateAgainstJsonSchema(data, suspension.resumeSchema);
  if (validationError !== null) {
    return c.json({ error: `Resume data validation failed: ${validationError}` }, 400);
  }

  // Find the runtime manifest — first try active runtimes, then global registry
  const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
  let effectiveManifest: RuntimeManifest | undefined = activeRuntimes.find((rt) => rt.name === suspension.runtimeId);

  if (!effectiveManifest) {
    // The plugin may exist in the registry but not be activated for this session.
    // Search across all registered entries.
    for (const [, entry] of pluginRegistry.getAll()) {
      const manifests = entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
      const found = manifests.find((m) => m.manifest.name === suspension.runtimeId);
      if (found) {
        pluginRegistry.activate(entry.id, sessionId);
        effectiveManifest = found.manifest;
        break;
      }
    }
  }

  if (!effectiveManifest) {
    return c.json({ error: `Runtime "${suspension.runtimeId}" not found in registry` }, 404);
  }

  try {
    const result = await resumeSuspendedRuntime(
      suspension,
      data,
      effectiveManifest,
      {
        loadRuntime: loadRuntimeFn,
        llm: llmAdapter,
        getConfig: c.get('getConfigFn') ?? ((_p: string, _r: string) => ({})),
        store,
        toolExecutor,
        resolveModel,
      },
    );

    return c.json({ result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Resume failed: ${message}` }, 500);
  }
});

// ── DELETE (abandon) ─────────────────────────────────────────────

resumeRoutes.delete('/:id/suspensions/:suspensionId', async (c) => {
  if (process.env['COVEL_SUSPEND_V1'] !== '1') {
    return c.json({ error: 'Suspend/resume feature is not enabled (COVEL_SUSPEND_V1)' }, 503);
  }

  const sessionId = c.req.param('id');
  const suspensionId = c.req.param('suspensionId');
  const store = c.get('store');

  const suspension = await store.getSuspension(suspensionId);
  if (!suspension || suspension.sessionId !== sessionId) {
    return c.json({ error: 'Suspension not found' }, 404);
  }

  await store.deleteSuspension(suspensionId);
  return c.json({ deleted: true, suspensionId });
});

// ── GET list ─────────────────────────────────────────────────────

resumeRoutes.get('/:id/suspensions', async (c) => {
  if (process.env['COVEL_SUSPEND_V1'] !== '1') {
    return c.json({ suspensions: [] });
  }

  const sessionId = c.req.param('id');
  const store = c.get('store');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const suspensions = await store.listSuspensions(sessionId);
  return c.json({ suspensions });
});
