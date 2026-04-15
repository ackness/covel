import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createPluginRegistry, type PluginRegistry } from "@covel/plugin-loader";
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
    expect(body.segments[1]?.rangeLabel).toBe("1-100");
    expect(body.steps.some((step) => step.runtimeId === "core-narrator" && step.isStoryRuntime)).toBe(true);
    expect(body.steps.some((step) => step.runtimeId === "core-pregame" && step.segmentId === "pre-game")).toBe(true);
    expect(body.steps.some((step) => step.priority === 500 && step.segmentId === "narrator")).toBe(true);
    expect(body.steps.some((step) => step.priority > 500 && step.segmentId === "post-narrator")).toBe(true);
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
