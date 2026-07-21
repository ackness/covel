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
import { reservedPluginDataNamespaceError } from "@covel/shared";
import { errorBody, readJsonBody } from "../../api-error.js";
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

/**
 * Core plugins own state the framework itself depends on (world dimension
 * schema, character records, memory blocks). The generic API is a player-facing
 * escape hatch for ordinary plugin state, so it must not be able to rewrite
 * those — a forged `world-init/schema` entry would redefine the world's
 * character attributes for every later turn. Core-plugin state changes go
 * through that plugin's own tools and the proposal pipeline.
 */
function corePluginWriteError(
  registry: PluginRegistry,
  pluginId: string,
): string | null {
  const entry = registry.get(pluginId);
  const pluginType =
    entry?.manifest?.manifest?.pluginType ?? entry?.summary?.pluginType;
  if (pluginType === "core-plugin") {
    return `Plugin "${pluginId}" is a core plugin; its data is framework-owned and cannot be written through this API`;
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
  if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

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
  if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

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
    if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

    const record = await store.getPluginData(
      sessionId,
      pluginId,
      namespace,
      key,
    );
    if (!record) {
      return c.json(errorBody("Not found"), 404);
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
    if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

    const reservedErr = reservedPluginDataNamespaceError(namespace);
    if (reservedErr) return c.json(errorBody(reservedErr), 403);
    const coreErr = corePluginWriteError(registry, pluginId);
    if (coreErr) return c.json(errorBody(coreErr), 403);

    const jsonBody = await readJsonBody(c);
    if (jsonBody instanceof Response) return jsonBody;
    const raw = jsonBody.body;
    // zod 4.4: bare z.unknown() is required; .optional() keeps 4.3 behaviour.
    const bodySchema = z.object({ value: z.unknown().optional() });
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(errorBody("Invalid body: value field is required"), 400);
    }
    if (parsed.data.value === undefined) {
      return c.json(errorBody("Invalid body: value field is required"), 400);
    }
    // Guard against oversized payloads (max 64KB serialized)
    const serialized = JSON.stringify(parsed.data.value);
    if (serialized.length > 65_536) {
      return c.json(errorBody("Value too large (max 64KB)"), 413);
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
    if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

    const reservedErr = reservedPluginDataNamespaceError(namespace);
    if (reservedErr) return c.json(errorBody(reservedErr), 403);
    const coreErr = corePluginWriteError(registry, pluginId);
    if (coreErr) return c.json(errorBody(coreErr), 403);

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
  if (accessErr) return c.json(errorBody(accessErr.error), accessErr.status);

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
