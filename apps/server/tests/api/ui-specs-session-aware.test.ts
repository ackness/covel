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
  type ParsedPluginMd,
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
      stage: "narrative",
      trigger: { type: "auto" },
    },
    promptTemplate: "",
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

function makeManifest(name: string, pluginId: string): ParsedPluginMd {
  return {
    manifest: {
      name,
      pluginId,
      description: "",
      stage: "narrative",
      trigger: { type: "auto" },
      ui: { right: ["./ui/panel.json"] },
    },
    promptTemplate: "",
    rawFrontmatter: {},
  } as ParsedPluginMd;
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
                  { id: "codex", label: "Codex", view: { component: "Stack" } },
                ],
              },
            }),
          ],
        ]),
        manifest: makeManifest("codex", "codex"),
        manifests: [makeManifest("codex", "codex")],
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
                  { id: "opt", label: "Opt", view: { component: "Stack" } },
                ],
              },
            }),
          ],
        ]),
        manifest: makeManifest("optional-plugin", "optional-plugin"),
        manifests: [makeManifest("optional-plugin", "optional-plugin")],
      }),
    );

    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: sessionId,
      worldId: null,
      status: "active",
      completedPlayerTurns: 1,

      presetId: null,
      activePlugins: ["codex"], // only codex active in this session
      createdAt: new Date().toISOString(),
    });

    app = createMiscApiRoutes(stubAi, registry, store);
  });

  it("returns the shared not-found error for an unknown session", async () => {
    const response = await app.request("/api/ui-specs?sessionId=missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Session not found: missing",
      code: "session_not_found",
    });
  });

  it("returns all registry specs when sessionId is omitted", async () => {
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
});
