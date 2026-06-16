/**
 * API Plugin Data routes — CRUD for plugin-scoped persistent data.
 *
 * Data is session-scoped and isolated by (sessionId, pluginId, namespace, key).
 *
 * Security: Write operations (PUT/DELETE) are restricted to plugins that are
 * currently active in the session. Read operations allow any registered plugin
 * to support cross-plugin data consumption (e.g. reading world schema from
 * the world-data-provider plugin). At T3 deployment, this entire route group
 * should be placed behind authentication middleware.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildPluginDataIndex } from "./discovery.js";
import { resolveSessionParam } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
  };
};

export const pluginDataRoutes = new Hono<Env>();

/**
 * Validate that the pluginId is a registered plugin and (for writes) active in the session.
 * Returns an error response if validation fails, or null if OK.
 */
function validatePluginAccess(
  registry: PluginRegistry,
  pluginId: string,
  sessionId: string,
  requireActive: boolean,
): { error: string; status: 403 | 404 } | null {
  const entry = registry.get(pluginId);
  if (!entry) {
    return { error: `Unknown plugin: ${pluginId}`, status: 404 };
  }
  if (requireActive) {
    const activeRuntimes = registry.getActiveRuntimes(sessionId);
    const isActive = activeRuntimes.some(
      (rt) => rt.name === pluginId || rt.name.startsWith(pluginId + "/"),
    );
    if (!isActive) {
      return {
        error: `Plugin "${pluginId}" is not active in this session`,
        status: 403,
      };
    }
  }
  return null;
}

// GET /session/:id/plugin-data/:pluginId/_index — list namespaces/keys without values
pluginDataRoutes.get("/:id/plugin-data/:pluginId/_index", async (c) => {
  const store = c.get("store");
  const registry = c.get("pluginRegistry");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const pluginId = c.req.param("pluginId");

  const accessErr = validatePluginAccess(registry, pluginId, sessionId, false);
  if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

  const records = await store.listPluginData(sessionId, pluginId);
  return c.json({
    sessionId,
    pluginId,
    namespaces: buildPluginDataIndex(records),
  });
});

// GET /session/:id/plugin-data/:pluginId/:namespace
pluginDataRoutes.get("/:id/plugin-data/:pluginId/:namespace", async (c) => {
  const store = c.get("store");
  const registry = c.get("pluginRegistry");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const pluginId = c.req.param("pluginId");
  const namespace = c.req.param("namespace");

  // Read: only require the plugin to be registered (not necessarily active)
  const accessErr = validatePluginAccess(registry, pluginId, sessionId, false);
  if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

  const records = await store.listPluginData(sessionId, pluginId, namespace);
  return c.json({
    items: records.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      updatedAt: r.updatedAt,
    })),
  });
});

// GET /session/:id/plugin-data/:pluginId/:namespace/:key
pluginDataRoutes.get(
  "/:id/plugin-data/:pluginId/:namespace/:key",
  async (c) => {
    const store = c.get("store");
    const registry = c.get("pluginRegistry");
    const sessionId = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const pluginId = c.req.param("pluginId");
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");

    const accessErr = validatePluginAccess(
      registry,
      pluginId,
      sessionId,
      false,
    );
    if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

    const record = await store.getPluginData(
      sessionId,
      pluginId,
      namespace,
      key,
    );
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({
      namespace: record.namespace,
      key: record.key,
      value: record.value,
      updatedAt: record.updatedAt,
    });
  },
);

// PUT /session/:id/plugin-data/:pluginId/:namespace/:key
pluginDataRoutes.put(
  "/:id/plugin-data/:pluginId/:namespace/:key",
  async (c) => {
    const store = c.get("store");
    const registry = c.get("pluginRegistry");
    const sessionId = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const pluginId = c.req.param("pluginId");
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");

    // Write: require the plugin to be active in this session
    const accessErr = validatePluginAccess(registry, pluginId, sessionId, true);
    if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

    const raw = await c.req.json<unknown>();
    const bodySchema = z.object({ value: z.unknown() });
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid body: value field is required" }, 400);
    }
    if (parsed.data.value === undefined) {
      return c.json({ error: "Invalid body: value field is required" }, 400);
    }
    // Guard against oversized payloads (max 64KB serialized)
    const serialized = JSON.stringify(parsed.data.value);
    if (serialized.length > 65_536) {
      return c.json({ error: "Value too large (max 64KB)" }, 413);
    }
    const body = parsed.data;
    const now = new Date().toISOString();

    await store.setPluginData({
      id: crypto.randomUUID(),
      sessionId,
      pluginId,
      namespace,
      key,
      value: body.value,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ success: true, namespace, key });
  },
);

// DELETE /session/:id/plugin-data/:pluginId/:namespace/:key
pluginDataRoutes.delete(
  "/:id/plugin-data/:pluginId/:namespace/:key",
  async (c) => {
    const store = c.get("store");
    const registry = c.get("pluginRegistry");
    const sessionId = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const pluginId = c.req.param("pluginId");
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");

    // Write: require the plugin to be active in this session
    const accessErr = validatePluginAccess(registry, pluginId, sessionId, true);
    if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

    await store.deletePluginData(sessionId, pluginId, namespace, key);
    return c.json({ success: true });
  },
);

// GET /session/:id/plugin-data/:pluginId — list all namespaces
pluginDataRoutes.get("/:id/plugin-data/:pluginId", async (c) => {
  const store = c.get("store");
  const registry = c.get("pluginRegistry");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const pluginId = c.req.param("pluginId");

  const accessErr = validatePluginAccess(registry, pluginId, sessionId, false);
  if (accessErr) return c.json({ error: accessErr.error }, accessErr.status);

  const records = await store.listPluginData(sessionId, pluginId);
  return c.json({
    items: records.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      updatedAt: r.updatedAt,
    })),
  });
});
