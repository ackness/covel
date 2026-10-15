// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("a minimal world", () => {
  it("loads, validates and starts a session with three fields and WORLD.md", async () => {
    // The directory names the world: world.yaml has no `id`.
    const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-minimal-"));
    const worldDir = path.join(worldsDir, "quiet-harbor");
    await mkdir(worldDir);
    await writeFile(
      path.join(worldDir, "world.yaml"),
      "name: Quiet Harbor\nsummary: A harbor where nothing has happened yet.\ndefaultLocale: en-US\n",
    );
    await writeFile(
      path.join(worldDir, "WORLD.md"),
      "# Quiet Harbor\n\nFog, a pier and one lamp.\n",
    );

    const validation = await validateWorldPackage({
      worldDir,
      pluginsDirs: [path.join(repoRoot, "plugins")],
      strict: true,
    });
    expect(validation.worldId).toBe("quiet-harbor");
    expect(validation.diagnostics).toEqual([]);

    const world = await loadSingleWorld(worldDir);
    expect(world).toMatchObject({
      id: "quiet-harbor",
      name: "Quiet Harbor",
      locale: "en-US",
    });

    const discovery = (
      await discoverPlugins(path.join(repoRoot, "plugins"))
    ).find((plugin) => plugin.id === "narrator");
    if (!discovery) throw new Error("Narrator fixture missing");
    const definition = await loadPluginDefinition(discovery);
    const registry = createPluginRegistry();
    registry.register({
      id: discovery.id,
      source: "builtin",
      rootPath: discovery.rootPath,
      summary: {
        id: discovery.id,
        name: discovery.id,
        description: "",
        pluginType: "plugin",
        runtimeCount: definition.manifests.length,
      },
      ...definition,
      loadedRuntimes: new Map(),
      status: "registered",
    });
    const store = createMemoryStore();
    await store.upsertWorld(world!);
    const lock = createInProcessSessionLock();
    const gate = createRpcApprovalGate();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("worldsDirs", [worldsDir]);
      c.set("sessionLock", lock);
      c.set("rpcApprovalGate", gate);
      c.set("activatePluginServerCode", async () => {});
      await next();
    });
    app.route("/api/sessions", sessionRoutes);

    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "minimal-session",
        worldId: "quiet-harbor",
        plugins: ["narrator"],
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(201);
    expect(await store.getSession("minimal-session")).toMatchObject({
      worldId: "quiet-harbor",
      locale: "en-US",
      activePlugins: ["narrator"],
      phase: "playing",
    });
    await store.close();
  });
});
