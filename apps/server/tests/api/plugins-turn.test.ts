/**
 * V2 Plugin and Turn route tests.
 *
 * Uses Hono's app.request() for lightweight HTTP testing without a running server.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { pluginRoutes } from "../../src/routes/api/plugins.js";
import { frameworkRoutes } from "../../src/routes/api/framework.js";
import { turnRoutes } from "../../src/routes/api/turn.js";
import {
  createPluginRegistry,
  type PluginRegistry,
  type SessionPluginScope,
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
    referenceLinks: [],
    rawFrontmatter: {},
  };
}

// ── App factory ──────────────────────────────────────────────────

type AppVariables = {
  pluginRegistry: PluginRegistry;
  sessionScopes: Map<string, SessionPluginScope>;
  store: DataStore;
};

function createTestApp(vars: AppVariables): Hono {
  const app = new Hono();

  // Inject dependencies via middleware
  app.use("*", async (c, next) => {
    c.set("pluginRegistry" as never, vars.pluginRegistry);
    c.set("sessionScopes" as never, vars.sessionScopes);
    c.set("store" as never, vars.store);
    await next();
  });

  app.route("/api/plugins", pluginRoutes);
  app.route("/api/framework", frameworkRoutes);
  app.route("/api/session", turnRoutes);
  return app;
}

// ── Plugin route tests ───────────────────────────────────────────

describe("V2 Plugin Routes", () => {
  let registry: PluginRegistry;
  let sessionScopes: Map<string, SessionPluginScope>;
  let store: DataStore;
  let app: Hono;

  beforeEach(() => {
    registry = createPluginRegistry();
    sessionScopes = new Map();
    store = createMemoryStore();
    app = createTestApp({ pluginRegistry: registry, sessionScopes, store });
  });

  describe("GET /api/plugins", () => {
    it("should return empty array when no plugins registered", async () => {
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ plugins: [] });
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
      expect(body.plugins).toHaveLength(2);
      expect(body.plugins[0]).toMatchObject({
        id: "plugin-a",
        name: "Plugin A",
      });
      expect(body.plugins[1]).toMatchObject({
        id: "plugin-b",
        name: "Plugin B",
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
      expect(body.name).toBe("My Plugin");
      expect(body.status).toBe("registered");
    });

    it("should return 404 when plugin not found", async () => {
      const res = await app.request("/api/plugins/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("GET /api/plugins/:id/contract", () => {
    it("returns manifest-derived plugin contracts for tooling", async () => {
      const parsed = makeParsedManifest({
        name: "my-plugin/runner",
        capabilities: ["image-generation"],
        runtimeType: "function",
        execution: "background",
        tools: {
          builtin: ["plugin-data-get"],
          local: ["./tools/save-image.js"],
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
        dataSchemas: {
          images: {
            namespace: "images",
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/images.json",
          },
        },
        ui: { right: ["./ui/panel.json"], message: ["./ui/message.json"] },
        rpc: {
          regenerate: {
            handler: "./rpc/regenerate.js",
            description: "Regenerate an image.",
          },
        },
      });
      registry.register(
        makeEntry({
          id: "my-plugin",
          summary: makeSummary({ id: "my-plugin", name: "My Plugin" }),
          manifest: parsed,
          manifests: [parsed],
        }),
      );

      const res = await app.request("/api/plugins/my-plugin/contract");
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
      });
      expect(body.tools.local).toEqual([
        {
          runtimeId: "my-plugin/runner",
          path: "./tools/save-image.js",
          name: "save-image",
        },
      ]);
      expect(body.runtimes[0]).toMatchObject({
        id: "my-plugin/runner",
        runtimeType: "function",
        readablePluginDataNamespaces: ["images"],
        writablePluginDataNamespaces: ["images"],
      });
      expect(body.rpc).toEqual([
        {
          runtimeId: "my-plugin/runner",
          action: "regenerate",
          handler: "./rpc/regenerate.js",
          streaming: false,
          description: "Regenerate an image.",
        },
      ]);
    });

    it("keeps missing plugin contract requests as 404", async () => {
      const res = await app.request("/api/plugins/missing/contract");
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
      expect(body.framework.pluginData.writePaths).toContain(
        "function-output:pluginData[]",
      );
      expect(body.framework.worldData.targetUris).toContain(
        "plugin:<pluginId>/<namespace>",
      );
      expect(body.framework.proposals.pluginDataTypes).toEqual([
        "plugin.data",
        "plugin.data.batch",
      ]);
    });
  });

  // PATCH /api/plugins/:id/config tests removed 2026-04-12.
  // The route was deleted because the underlying sessionScopes Map was never
  // populated by any production code path. See audits/2026-04-12-backend-webv2-framework-audit
  // Finding 2. Per-session config now lives in loadSessionConfig() + plugin_data.
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

// ── Turn route tests ─────────────────────────────────────────────

describe("V2 Turn Routes", () => {
  let registry: PluginRegistry;
  let sessionScopes: Map<string, SessionPluginScope>;
  let store: DataStore;
  let app: Hono;

  beforeEach(() => {
    registry = createPluginRegistry();
    sessionScopes = new Map();
    store = createMemoryStore();
    app = createTestApp({ pluginRegistry: registry, sessionScopes, store });
  });

  describe("POST /api/session/:id/turn", () => {
    it("should return 404 for unknown session", async () => {
      const res = await app.request("/api/session/unknown-sess/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });
});
