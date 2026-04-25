import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  createPluginRegistry,
  type ParsedPluginMd,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
  slotRegistry: { listSlots: () => ({}) },
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

describe("plugin flow routes", () => {
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;

  beforeEach(() => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    app = createMiscApiRoutes(stubAi, registry, store);
  });

  it("returns the segmented plugin flow payload", async () => {
    const res = await app.request("/api/plugin-flows");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      segments: Array<{ id: string; rangeLabel: string }>;
      steps: Array<{ runtimeId: string; priority: number; segmentId: string; isStoryRuntime: boolean }>;
    };

    expect(body.segments.map((segment) => segment.id)).toEqual([
      "start",
      "pre-game",
      "pre-narrator",
      "narrator",
      "post-narrator",
    ]);
    // audit P0-1: Pre-Game band aligned to 1-99 to match scheduler edges.
    expect(body.segments[1]?.rangeLabel).toBe("1-99");
    expect(body.steps.some((step) => step.runtimeId === "core-narrator" && step.isStoryRuntime)).toBe(true);
    expect(body.steps.some((step) => step.runtimeId === "core-pregame" && step.segmentId === "pre-game")).toBe(true);
    expect(body.steps.some((step) => step.priority === 500 && step.segmentId === "narrator")).toBe(true);
    expect(body.steps.some((step) => step.priority > 500 && step.segmentId === "post-narrator")).toBe(true);
  });

  it("returns package runtime triggers with mode-shaped metadata", async () => {
    const manifest: RuntimeManifest = {
      name: "test-package",
      description: "Test runtime",
      runtimeType: "agent",
      priority: 123,
      trigger: { type: "scheduled", interval: 3 },
    };
    const parsed: ParsedPluginMd = {
      manifest,
      promptTemplate: "",
      referenceLinks: [],
      rawFrontmatter: {},
    };
    const entry: PluginRegistryEntry = {
      id: "test-package",
      summary: {
        id: "test-package",
        name: "Test Package",
        description: "Package from the registry",
        pluginType: "core-plugin",
        runtimeCount: 1,
      },
      manifests: [parsed],
      manifest: parsed,
      loadedRuntimes: new Map(),
      status: "registered",
      source: "builtin",
    };
    registry.register(entry);

    const res = await app.request("/api/packages");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      packages: Array<{
        name: string;
        source?: string;
        runtimes?: Array<{ trigger: { mode?: string; type?: string; interval?: number } }>;
      }>;
    };
    const pkg = body.packages.find((item) => item.name === "test-package");
    expect(pkg?.source).toBe("builtin");
    expect(pkg?.runtimes?.[0]?.trigger).toEqual({
      mode: "scheduled",
      interval: 3,
    });
  });

  it("returns raw plugin documents grouped by runtime", async () => {
    const res = await app.request("/api/plugin-docs/core-char-creator");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      pluginId: string;
      docs: Array<{ runtimeId: string; path: string; content: string }>;
    };

    expect(body.pluginId).toBe("core-char-creator");
    expect(body.docs.some((doc) => doc.runtimeId === "core-char-creator/player-init")).toBe(true);
    expect(body.docs.some((doc) => doc.path.includes("plugins/core-char-creator/runtimes/player-init/PLUGIN.md"))).toBe(true);
    expect(body.docs.some((doc) => doc.content.includes("name: core-char-creator/player-init"))).toBe(true);
  });
});
