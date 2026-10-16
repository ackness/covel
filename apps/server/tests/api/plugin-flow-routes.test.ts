import { beforeEach, describe, expect, it } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  createPluginRegistry,
  parsePluginMd,
  type ParsedRuntimeMd,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { pluginRoutes } from "../../src/routes/api/plugins.js";

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
    app.use("/api/plugins/*", async (c, next) => {
      c.set("pluginRegistry", registry);
      await next();
    });
    app.route("/api/plugins", pluginRoutes);
  });

  it("returns the segmented plugin flow payload", async () => {
    const registerRuntime = (args: {
      pluginId: string;
      runtimeId: string;
      stage?: RuntimeManifest["stage"];
      outputContract?: string;
      outputKind?: RuntimeManifest["outputKind"];
      trigger?: RuntimeManifest["trigger"];
    }) => {
      const manifest: RuntimeManifest = {
        name: args.runtimeId,
        pluginId: args.pluginId,
        description: args.runtimeId,
        runtimeType: "agent",
        execution: "sync",
        ...(args.stage ? { stage: args.stage } : {}),
        ...(args.outputContract ? { outputContract: args.outputContract } : {}),
        ...(args.outputKind ? { outputKind: args.outputKind } : {}),
        trigger: args.trigger ?? { type: "auto" },
      };
      const parsed: ParsedRuntimeMd = {
        runtime: manifest.runtimeType === "function" ? { function: {} } : {},
        manifest,
        promptTemplate: "",
        rawFrontmatter: {},
      };
      registry.register({
        id: args.pluginId,
        summary: {
          id: args.pluginId,
          name: args.pluginId,
          description: args.pluginId,
          kind: "plugin",
          runtimeCount: 1,
        },
        manifests: [parsed],
        loadedRuntimes: new Map(),
        status: "registered",
        source: "builtin",
      });
    };
    registerRuntime({
      pluginId: "narrator",
      runtimeId: "narrator",
      stage: "narrative",
      outputContract: "narrative-engine@1",
      outputKind: "story",
    });
    registerRuntime({
      pluginId: "pregame",
      runtimeId: "pregame",
      stage: "setup",
    });
    registerRuntime({
      pluginId: "guide",
      runtimeId: "guide",
      stage: "post-turn",
    });
    registerRuntime({
      pluginId: "scene-stage",
      runtimeId: "scene-stage/resolver",
      trigger: { type: "manual" },
    });

    const res = await app.request("/api/plugin-flows");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      segments: Array<{ id: string }>;
      plugins: Array<{ kind: string }>;
      steps: Array<{
        runtimeId: string;
        segmentId: string;
        isStoryRuntime: boolean;
        outputContract?: string;
        execution: string;
      }>;
    };

    for (const item of [...body.plugins, ...body.steps]) {
      expect(item).toHaveProperty("kind", "plugin");
      expect(item).not.toHaveProperty("pluginType");
    }
    expect(body.segments.map((segment) => segment.id)).toEqual([
      "setup",
      "pre-turn",
      "narrative",
      "post-turn",
      "audit",
      "event-manual",
    ]);
    expect(
      body.steps.some(
        (step) =>
          step.runtimeId === "narrator" &&
          step.isStoryRuntime &&
          step.outputContract === "narrative-engine@1" &&
          step.execution === "sync",
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
      pluginId: "test-package",
      description: "Test runtime",
      runtimeType: "agent",
      execution: "background",
      stage: "pre-turn",
      trigger: { type: "auto", every: 3 },
      outputContract: "narrative-engine@1",
      turnCompletion: {
        mode: "detached",
        maxQueueMs: 30_000,
      },
    };
    const parsed: ParsedRuntimeMd = {
      runtime: manifest.runtimeType === "function" ? { function: {} } : {},
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
        kind: "core",
        runtimeCount: 1,
        // The loader's order: a written tag, then the derived ones.
        tags: ["mode:dialogue", "cost:llm", "ui:right-panel"],
      },
      packageManifest: parsePluginMd(
        "---\nid: test-package\nkind: core\ndescription: Test\ntags: [mode:dialogue]\nprovides: [narrative-engine@1]\n---\n",
        "test-package/PLUGIN.md",
      ),
      manifests: [parsed],
      loadedRuntimes: new Map(),
      status: "registered",
      source: "builtin",
    };
    registry.register(entry);

    const res = await app.request("/api/plugins");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{
        id: string;
        displayName?: unknown;
        description?: unknown;
        source?: string;
        provides?: string[];
        tags?: string[];
        runtimes?: Array<{
          trigger: { type?: string; every?: number };
          outputContract?: string;
          execution?: string;
          turnCompletion?: { mode: string; maxQueueMs?: number };
        }>;
      }>;
    };
    const pkg = body.items.find((item) => item.id === "test-package");
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
    expect(pkg?.provides).toEqual(["narrative-engine@1"]);
    // Not sorted: the prep screen groups a plugin under its first tag.
    expect(pkg?.tags).toEqual(["mode:dialogue", "cost:llm", "ui:right-panel"]);
    expect(pkg?.runtimes?.[0]?.trigger).toEqual({
      type: "auto",
      every: 3,
    });
    expect(pkg?.runtimes?.[0]?.outputContract).toBe("narrative-engine@1");
    expect(pkg?.runtimes?.[0]?.execution).toBe("background");
    expect(pkg?.runtimes?.[0]).not.toHaveProperty("tags");
    expect(pkg?.runtimes?.[0]?.turnCompletion).toEqual({
      mode: "detached",
      maxQueueMs: 30_000,
    });
  });
});
