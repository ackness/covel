/**
 * GET /api/ui-specs — session-aware filtering by activePlugins.
 * Fix for 2026-04-12 audit Finding w2.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

// The AiStack shape misc-api needs — stub the minimum surface for the test.
const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "plugin",
    name: "Plugin",
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeLoadedRuntime(args: {
  name: string;
  pluginId: string;
  uiSpecs?: unknown;
}): LoadedRuntime {
  return {
    manifest: {
      name: args.name,
      pluginId: args.pluginId,
      priority: 500,
      trigger: { type: "auto" },
    },
    promptTemplate: "",
    referenceLinks: [],
    rawFrontmatter: {},
    uiSpecs: args.uiSpecs,
  } as unknown as LoadedRuntime;
}

function makeEntry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id: "plugin",
    status: "registered",
    summary: makeSummary(),
    loadedRuntimes: new Map(),
    ...overrides,
  } as PluginRegistryEntry;
}

describe("GET /api/ui-specs session-aware filter", () => {
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = "sess-1";

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();

    // Register two plugins, each with a right-panel spec
    registry.register(
      makeEntry({
        id: "codex",
        summary: makeSummary({
          id: "codex",
          name: "Codex",
          pluginType: "core-plugin",
        }),
        loadedRuntimes: new Map([
          [
            "codex",
            makeLoadedRuntime({
              name: "codex",
              pluginId: "codex",
              uiSpecs: {
                right: [
                  { id: "codex", label: "Codex", component: "Stack", view: {} },
                ],
              },
            }),
          ],
        ]),
      }),
    );
    registry.register(
      makeEntry({
        id: "optional-plugin",
        summary: makeSummary({
          id: "optional-plugin",
          name: "Optional",
          pluginType: "plugin",
        }),
        loadedRuntimes: new Map([
          [
            "optional-plugin",
            makeLoadedRuntime({
              name: "optional-plugin",
              pluginId: "optional-plugin",
              uiSpecs: {
                right: [
                  { id: "opt", label: "Opt", component: "Stack", view: {} },
                ],
              },
            }),
          ],
        ]),
      }),
    );

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ["codex"], // only codex active in this session
      createdAt: new Date().toISOString(),
    });

    app = createMiscApiRoutes(stubAi, registry, store);
  });

  it("returns all specs when sessionId is omitted (back-compat)", async () => {
    const res = await app.request("/api/ui-specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { right: Array<{ pluginId: string }> };
    expect(body.right).toHaveLength(2);
  });

  it("filters to the session activePlugins when sessionId is provided", async () => {
    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { right: Array<{ pluginId: string }> };
    expect(body.right).toHaveLength(1);
    expect(body.right[0].pluginId).toBe("codex");
  });

  it("falls back to all specs if sessionId does not match a session", async () => {
    const res = await app.request("/api/ui-specs?sessionId=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { right: Array<{ pluginId: string }> };
    // When session lookup fails, we leave activeFilter null — full list returned.
    expect(body.right).toHaveLength(2);
  });
});
