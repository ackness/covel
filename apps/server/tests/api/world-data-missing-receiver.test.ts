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
import { loadSingleWorld } from "../../src/world-seed-loader.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const worldsDirs = [path.join(repoRoot, "worlds")];

describe("session creation without installed world-data receivers", () => {
  it.each(["haruka-academy", "lantern-barrow", "mistport"])(
    "starts %s with only narrator installed and leaves the plugins' data out",
    async (worldId) => {
      const registry = createPluginRegistry();
      const discovery = (
        await discoverPlugins(path.join(repoRoot, "plugins"))
      ).find((plugin) => plugin.id === "narrator");
      if (!discovery) throw new Error("Narrator fixture missing");
      const definition = await loadPluginDefinition(discovery);
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
      expect([...registry.getAll().keys()]).toEqual(["narrator"]);

      const store = createMemoryStore();
      const world = await loadSingleWorld(path.join(worldsDirs[0]!, worldId));
      if (!world) throw new Error(`World fixture missing: ${worldId}`);
      await store.upsertWorld(world);
      const app = new Hono();
      const lock = createInProcessSessionLock();
      const gate = createRpcApprovalGate();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", registry);
        c.set("worldsDirs", worldsDirs);
        c.set("sessionLock", lock);
        c.set("rpcApprovalGate", gate);
        c.set("activatePluginServerCode", async () => {});
        await next();
      });
      app.route("/api/sessions", sessionRoutes);

      const id = `${worldId}-narrator-only`;
      const response = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, worldId, plugins: ["narrator"] }),
      });
      const responseText = await response.text();
      expect(response.status, responseText).toBe(201);
      const body = JSON.parse(responseText);
      // Without its plugin a file at a conventional path is no source: the
      // session leaves it out, and the preparation screen names the world's
      // missing plugins. What the session cannot keep is reported.
      expect(body.worldDataNotices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("world.dimensions@1"),
          }),
        ]),
      );
      expect(body.worldDataNotices).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ level: "error" })]),
      );
      expect(await store.getSession(id)).toMatchObject({
        activePlugins: ["narrator"],
        phase: "playing",
        setupRuntimes: {},
      });
      // Kernel-owned characters still import even though plugin data is skipped.
      expect((await store.listCharacters(id)).length).toBeGreaterThan(0);
      expect(await store.listWorldDataImportLedger(id)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "contract:character.blueprints@1",
          }),
        ]),
      );
    },
  );
});
