/**
 * API Plugin routes — list loaded plugins and expose manifest-derived
 * contracts for developer tooling and AI agents.
 *
 * NOTE: The PATCH /:id/config route was removed in 2026-04-12 because the
 * `sessionScopes` map it depended on was never populated by any production
 * code path. See audits/2026-04-12-backend-webv2-framework-audit Finding 2.
 * Runtime config now comes from explicit runtime/plugin settings.
 */

import { homedir } from "node:os";
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { readRuntimeEnv } from "@covel/shared";
import { buildPluginContract, summarizePluginManifests } from "./discovery.js";
import { errorBody } from "../../api-error.js";

type Env = {
  Variables: {
    pluginRegistry: PluginRegistry;
  };
};

/** Resolve the user plugins directory the same way the install route does. */
function resolveUserPluginsDir(): string {
  const env = readRuntimeEnv();
  return (
    env.userPluginsDir ??
    (env.covelHome
      ? path.join(env.covelHome, "plugins")
      : path.join(homedir(), ".covel", "plugins"))
  );
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export const pluginRoutes = new Hono<Env>();

// GET /plugins — List all loaded plugins
pluginRoutes.get("/", async (c) => {
  const registry = c.get("pluginRegistry");
  const all = registry.getAll();
  const plugins = Array.from(all.values()).map((entry) => {
    const { capabilities, tags, relations, outputKind } =
      summarizePluginManifests(entry);
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      runtimeCount: entry.summary.runtimeCount,
      status: entry.status,
      source: entry.source,
      capabilities,
      tags,
      ...(relations ? { relations } : {}),
      outputKind,
    };
  });
  return c.json({ plugins });
});

// GET /plugins/:id/contract — Manifest-derived plugin contract.
pluginRoutes.get("/:id/contract", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json(errorBody(`Plugin "${id}" not found`), 404);
  }
  return c.json(buildPluginContract(entry));
});

// GET /plugins/:id — Get plugin details
pluginRoutes.get("/:id", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json(errorBody(`Plugin "${id}" not found`), 404);
  }
  const { capabilities, tags, relations, outputKind } =
    summarizePluginManifests(entry);
  return c.json({
    id: entry.id,
    name: entry.summary.name,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    runtimeCount: entry.summary.runtimeCount,
    status: entry.status,
    source: entry.source,
    capabilities,
    tags,
    ...(relations ? { relations } : {}),
    outputKind,
  });
});

// DELETE /plugins/:id — uninstall a third-party plugin from the user plugins
// dir. Builtin plugins cannot be removed. Mirrors the install route's id rules
// and returns restartRequired:true (the loader only re-scans the dir at boot).
pluginRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Format guard — also blocks path traversal (no `/`, `.`, `..`).
  if (!PLUGIN_ID_RE.test(id)) {
    return c.json(errorBody(`invalid plugin id: ${id}`), 400);
  }

  // A builtin plugin always loads (autoLoad), so registry.source is the
  // authoritative builtin check; never delete a shipped plugin.
  const entry = c.get("pluginRegistry").get(id);
  if (entry?.source === "builtin") {
    return c.json(errorBody(`cannot uninstall builtin plugin "${id}"`), 409);
  }

  const root = resolveUserPluginsDir();
  const finalDir = path.join(root, id);
  // Defense in depth: the resolved dir must stay strictly under the root.
  const rel = path.relative(root, finalDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return c.json(errorBody("invalid plugin path"), 400);
  }

  try {
    await stat(finalDir);
  } catch {
    return c.json(errorBody(`plugin "${id}" is not installed`), 404);
  }

  await rm(finalDir, { recursive: true, force: true });
  return c.json({ ok: true, id, restartRequired: true });
});
