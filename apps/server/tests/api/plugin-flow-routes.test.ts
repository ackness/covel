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

    const body = (await res.json()) as {
      segments: Array<{ id: string; rangeLabel: string }>;
      steps: Array<{
        runtimeId: string;
        priority: number;
        segmentId: string;
        isStoryRuntime: boolean;
      }>;
    };

    expect(body.segments.map((segment) => segment.id)).toEqual([
      "setup",
      "pre-turn",
      "narrative",
      "post-turn",
      "audit",
      "event-manual",
    ]);
    // Setup stage folds the old 0-99 band.
    expect(body.segments[0]?.rangeLabel).toBe("0-99");
    expect(
      body.steps.some(
        (step) => step.runtimeId === "narrator" && step.isStoryRuntime,
      ),
    ).toBe(true);
    expect(
      body.steps.some(
        (step) => step.runtimeId === "pregame" && step.segmentId === "setup",
      ),
    ).toBe(true);
    expect(
      body.steps.some(
        (step) =>
          step.runtimeId === "narrator" && step.segmentId === "narrative",
      ),
    ).toBe(true);
    expect(
      body.steps.some(
        (step) => step.runtimeId === "guide" && step.segmentId === "post-turn",
      ),
    ).toBe(true);
    // Event runtimes are stage-less → grouped under the event-manual bucket.
    expect(
      body.steps.some(
        (step) =>
          step.runtimeId === "scene-stage/resolver" &&
          step.segmentId === "event-manual",
      ),
    ).toBe(true);
  });

  it("returns package runtime triggers with mode-shaped metadata", async () => {
    const manifest: RuntimeManifest = {
      name: "test-package",
      description: "Test runtime",
      runtimeType: "agent",
      priority: 123,
      trigger: { type: "scheduled", interval: 3 },
      capabilities: ["narrative"],
      tags: ["mode:dialogue", "role:narrator"],
      relations: { provides: ["narrative-engine"] },
    };
    const parsed: ParsedPluginMd = {
      manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const entry: PluginRegistryEntry = {
      id: "test-package",
      summary: {
        id: "test-package",
        name: "Test Package",
        displayName: { "zh-CN": "测试包", "en-US": "Test Pkg" },
        description: {
          "zh-CN": "注册表里的包",
          "en-US": "Package from the registry",
        },
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

    const body = (await res.json()) as {
      packages: Array<{
        name: string;
        displayName?: unknown;
        description?: unknown;
        source?: string;
        capabilities?: string[];
        tags?: string[];
        relations?: Record<string, unknown>;
        runtimes?: Array<{
          trigger: { type?: string; interval?: number };
          tags?: string[];
          relations?: Record<string, unknown>;
        }>;
      }>;
    };
    const pkg = body.packages.find((item) => item.name === "test-package");
    // displayName / description are served as RAW I18nText (the frontend
    // resolves to the UI locale) — never collapsed to a single locale here.
    expect(pkg?.displayName).toEqual({
      "zh-CN": "测试包",
      "en-US": "Test Pkg",
    });
    expect(pkg?.description).toEqual({
      "zh-CN": "注册表里的包",
      "en-US": "Package from the registry",
    });
    expect(pkg?.source).toBe("builtin");
    expect(pkg?.capabilities).toEqual(["narrative"]);
    expect(pkg?.tags).toEqual(["mode:dialogue", "role:narrator"]);
    expect(pkg?.relations).toEqual({ provides: ["narrative-engine"] });
    expect(pkg?.runtimes?.[0]?.trigger).toEqual({
      type: "scheduled",
      interval: 3,
    });
    expect(pkg?.runtimes?.[0]?.tags).toEqual([
      "mode:dialogue",
      "role:narrator",
    ]);
  });
});
