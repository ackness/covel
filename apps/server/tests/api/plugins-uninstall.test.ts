import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginRegistry } from "@covel/plugin-loader";
import { pluginRoutes } from "../../src/routes/api/plugins.js";

let pluginsDir: string;
let prevUserPluginsDir: string | undefined;

// Minimal registry stub — the uninstall route only reads `get(id)?.source`.
function makeRegistry(builtinIds: string[] = ["narrator"]): PluginRegistry {
  return {
    get: (id: string) =>
      builtinIds.includes(id) ? { source: "builtin" } : undefined,
    getAll: () => new Map(),
  } as unknown as PluginRegistry;
}

function createTestApp(registry: PluginRegistry = makeRegistry()): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginRegistry", registry);
    await next();
  });
  app.route("/api/plugins", pluginRoutes);
  return app;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "covel-uninstall-"));
  prevUserPluginsDir = process.env.COVEL_USER_PLUGINS_DIR;
  process.env.COVEL_USER_PLUGINS_DIR = pluginsDir;
});

afterEach(async () => {
  if (prevUserPluginsDir === undefined) {
    delete process.env.COVEL_USER_PLUGINS_DIR;
  } else {
    process.env.COVEL_USER_PLUGINS_DIR = prevUserPluginsDir;
  }
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("DELETE /api/plugins/:id (uninstall)", () => {
  it("removes an installed third-party plugin dir and reports restartRequired", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const res = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      id: "my-plugin",
      restartRequired: true,
    });
    await expect(access(dir)).rejects.toThrow(); // dir is gone
  });

  it("rejects uninstalling a builtin plugin with 409", async () => {
    // Even if a dir somehow exists, a builtin id must never be removed.
    await mkdir(path.join(pluginsDir, "narrator"), { recursive: true });
    const app = createTestApp(makeRegistry(["narrator"]));

    const res = await app.request("/api/plugins/narrator", {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    // The dir survives.
    await access(path.join(pluginsDir, "narrator"));
  });

  it("returns 404 when the plugin is not installed", async () => {
    const app = createTestApp();
    const res = await app.request("/api/plugins/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid plugin id with 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/plugins/bad.name", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("rejects path-traversal ids and never deletes outside the plugins root", async () => {
    // A sibling directory outside the user plugins root — must survive.
    const outside = path.join(path.dirname(pluginsDir), "OUTSIDE-SECRET");
    await mkdir(outside, { recursive: true });
    const app = createTestApp();

    // Each id contains "/" and/or "." which PLUGIN_ID_RE rejects before any
    // filesystem access; the path.relative() guard is the second line. Whether
    // Hono decodes %2F or not, the param never satisfies the id regex.
    for (const id of [
      encodeURIComponent("../OUTSIDE-SECRET"),
      encodeURIComponent("../../OUTSIDE-SECRET"),
      "..%2F..%2FOUTSIDE-SECRET",
    ]) {
      const res = await app.request(`/api/plugins/${id}`, { method: "DELETE" });
      expect(res.status, `id=${id}`).toBe(400);
    }

    // The outside directory is untouched.
    await access(outside);
    await rm(outside, { recursive: true, force: true });
  });
});
