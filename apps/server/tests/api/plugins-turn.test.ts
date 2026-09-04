/**
 * Plugin route tests (`/api/plugins`, `/api/framework`).
 *
 * Uses Hono's app.request() for lightweight HTTP testing without a running server.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { pluginRoutes } from "../../src/routes/api/plugins.js";
import { frameworkRoutes } from "../../src/routes/api/framework.js";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginSummary,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";

// ── Helpers ──────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<PluginSummary>): PluginSummary {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    description: "A test plugin",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(
  overrides?: Partial<PluginRegistryEntry>,
): PluginRegistryEntry {
  return {
    id: "test-plugin",
    summary: makeSummary(),
    loadedRuntimes: new Map(),
    status: "registered",
    ...overrides,
  };
}

function makeParsedManifest(
  manifest: Partial<import("@covel/shared").RuntimeManifest> & {
    name: string;
    description?: string;
  },
) {
  return {
    manifest: {
      name: manifest.name,
      description: manifest.description ?? `${manifest.name} runtime`,
      pluginType: "plugin",
      outputKind: "plugin",
      trigger: { type: "manual" },
      ...manifest,
    },
    promptTemplate: "",
    rawFrontmatter: {},
  };
}

// ── App factory ──────────────────────────────────────────────────

type AppVariables = {
  pluginRegistry: PluginRegistry;
  store: DataStore;
};

function createTestApp(vars: AppVariables): Hono {
  const app = new Hono();

  // Inject dependencies via middleware
  app.use("*", async (c, next) => {
    c.set("pluginRegistry" as never, vars.pluginRegistry);
    c.set("store" as never, vars.store);
    await next();
  });

  app.route("/api/plugins", pluginRoutes);
  app.route("/api/framework", frameworkRoutes);
  return app;
}

// ── Plugin route tests ───────────────────────────────────────────

describe("Plugin Routes", () => {
  let registry: PluginRegistry;
  let store: DataStore;
  let app: Hono;

  beforeEach(() => {
    registry = createPluginRegistry();
    store = createMemoryStore();
    app = createTestApp({ pluginRegistry: registry, store });
  });

  describe("GET /api/plugins", () => {
    it("should return empty array when no plugins registered", async () => {
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ items: [] });
    });

    it("should return all registered plugins", async () => {
      registry.register(
        makeEntry({
          id: "plugin-a",
          summary: makeSummary({ id: "plugin-a", name: "Plugin A" }),
        }),
      );
      registry.register(
        makeEntry({
          id: "plugin-b",
          summary: makeSummary({ id: "plugin-b", name: "Plugin B" }),
        }),
      );

      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toMatchObject({
        id: "plugin-a",
        displayName: "Plugin A",
      });
      expect(body.items[1]).toMatchObject({
        id: "plugin-b",
        displayName: "Plugin B",
      });
    });
  });

  describe("GET /api/plugins/:id", () => {
    it("should return plugin details when found", async () => {
      registry.register(
        makeEntry({
          id: "my-plugin",
          summary: makeSummary({ id: "my-plugin", name: "My Plugin" }),
        }),
      );

      const res = await app.request("/api/plugins/my-plugin");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("my-plugin");
      expect(body.displayName).toBe("My Plugin");
      expect(body.status).toBe("registered");
    });

    it("should return 404 when plugin not found", async () => {
      const res = await app.request("/api/plugins/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("canonical plugin detail", () => {
    it("includes manifest-derived contracts in the plugin resource", async () => {
      const parsed = makeParsedManifest({
        name: "my-plugin/runner",
        capabilities: ["image-generation"],
        runtimeType: "function",
        execution: "background",
        tools: {
          builtin: ["plugin-data-get"],
          plugin: ["save-image"],
        },
        input: {
          inject: [
            {
              kind: "plugin-data",
              namespace: "images",
              as: "<images>",
              format: "summary",
              maxEntries: 50,
            },
          ],
        },
        inputs: {
          worldIR: {
            from: {
              capability: "world-ir-provider",
              cardinality: "one",
            },
            accepts: "covel://world/ir/v1",
            required: true,
          },
        },
        dataSchemas: {
          images: {
            namespace: "images",
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/images.json",
          },
        },
        worldProjections: {
          "images-from-world-ir": {
            from: "covel://world/ir/v1",
            handler: "./server/project-world-ir.js",
            outputs: {
              images: { namespace: "images", key: "id" },
            },
          },
        },
        ui: { right: ["./ui/panel.json"], message: ["./ui/message.json"] },
      });
      registry.register(
        makeEntry({
          id: "my-plugin",
          summary: makeSummary({ id: "my-plugin", name: "My Plugin" }),
          manifest: parsed,
          manifests: [parsed],
        }),
      );

      const res = await app.request("/api/plugins/my-plugin");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: "my-plugin",
        capabilities: ["image-generation"],
        declaredPluginDataNamespaces: ["images"],
        dataSchemas: {
          images: {
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/images.json",
          },
        },
        worldProjections: {
          "images-from-world-ir": {
            from: "covel://world/ir/v1",
            outputs: {
              images: { namespace: "images", key: "id" },
            },
          },
        },
      });
      // Runtime-local tools are declared by name; there is no on-disk path.
      expect(body.runtimes[0].tools.local).toEqual([{ name: "save-image" }]);
      expect(body.runtimes[0]).toMatchObject({
        id: "my-plugin/runner",
        runtimeType: "function",
        after: [],
        needs: [],
        inputs: {
          worldIR: {
            from: {
              capability: "world-ir-provider",
              cardinality: "one",
            },
            accepts: "covel://world/ir/v1",
            required: true,
          },
        },
        readablePluginDataNamespaces: ["images"],
        writablePluginDataNamespaces: ["images"],
        effects: {
          reads: ["plugin-data:self:images"],
          writes: ["ui:message", "ui:right"],
          parallelSafe: false,
        },
      });
    });

    it("keeps missing plugin detail requests as 404", async () => {
      const res = await app.request("/api/plugins/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/framework/capabilities", () => {
    it("returns framework-level capability enums and discovery anchors", async () => {
      const res = await app.request("/api/framework/capabilities");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.framework.pluginManifest.triggerTypes).toContain("manual");
      expect(body.framework.pluginManifest.uiSlots).toEqual([
        "right",
        "message",
        "left",
      ]);
      expect(body.framework.scheduling.effectsPolicy).toBe(
        process.env.COVEL_EFFECTS_POLICY === "strict" ? "strict" : "warn",
      );
      expect(body.framework.pluginData.writePaths).toContain(
        "function-output:pluginData[]",
      );
      expect(body.framework.worldData.targetUris).toContain(
        "plugin:<pluginId>/<namespace>",
      );
      expect(body.framework.worldData.effects).toContain("projections");
      expect(body.framework.worldData.schemaUris).toContain(
        "covel://world/ir/v1",
      );
      expect(
        body.framework.worldData.schemas["covel://world/ir/v1"],
      ).toMatchObject({
        $id: "covel://world/ir/v1",
        type: "object",
        required: [
          "schemaVersion",
          "entities",
          "relations",
          "events",
          "statements",
        ],
      });
      expect(body.framework.proposals.pluginDataTypes).toEqual([
        "plugin.data",
        "plugin.data.batch",
      ]);
    });
  });

  // This route remains intentionally absent: per-session configuration lives
  // in runtime/plugin settings, so mounting a parallel sessionScopes-backed
  // endpoint would create a second source of truth.
  describe("PATCH /api/plugins/:id/config (route removed)", () => {
    it("returns 404 because the route is no longer mounted", async () => {
      const res = await app.request("/api/plugins/cfg-plugin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "sess-1",
          config: { difficulty: "hard" },
        }),
      });
      // Hono returns 404 for unmatched routes
      expect(res.status).toBe(404);
    });
  });
});
