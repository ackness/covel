/**
 * API Plugin routes — list loaded plugins and expose manifest-derived
 * contracts for developer tooling and AI agents.
 */

import { homedir } from "node:os";
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { readRuntimeEnv } from "@covel/shared";
import {
  buildPluginDetail,
  buildPluginSummary,
} from "../../lib/plugin-descriptor.js";
import { errorBody, okBody } from "../../api-error.js";
import { makeInstallApiGuard } from "../privileged-auth.js";

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
  return c.json({
    items: [...registry.getAll().values()].map(buildPluginSummary),
  });
});

// GET /plugins/:id — Get plugin details
pluginRoutes.get("/:id", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json(
      errorBody(`Plugin "${id}" not found`, { code: "plugin_not_found" }),
      404,
    );
  }
  return c.json(buildPluginDetail(entry));
});

// DELETE /plugins/:id — uninstall a third-party plugin from the user plugins
// dir. Builtin plugins cannot be removed. Mirrors the install route's id rules
// and returns restartRequired:true (the loader only re-scans the dir at boot).
pluginRoutes.delete("/:id", makeInstallApiGuard(), async (c) => {
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
  return c.json(okBody({ id, restartRequired: true }));
});
