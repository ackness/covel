/**
 * Integration test for `plugins/scene-stage` — the first real consumer of
 * the unified event emission layer (E): an emitter emits `scene.set`, the
 * same-turn event fan-out (`runEventChain`) triggers the real scene-stage
 * resolver, and its `plugin.data` proposal commits `stage/current`.
 *
 * `@covel/plugin-test-utils`'s `createTestHarness` (since removed from the
 * package) was tried first and found insufficient for this scenario:
 * it only discovered runtimes from a filesystem `pluginsDir` with no way to
 * inject a synthetic MockLLM-driven "emitter" runtime alongside the real
 * scene-stage plugin, and it never called `processRuntimeResult`, so a turn
 * it ran never landed anything in the store. Uses the
 * turn-executor direct-construction pattern from
 * emit-event-integration.test.ts, loading the real scene-stage handler via
 * `@covel/plugin-loader` instead of a hand-written stand-in.
 */

import path from "node:path";
import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createEmitEventTool, type EventDirectoryLike } from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { processRuntimeResult } from "../src/session/session-kernel.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");
const SESSION_ID = "sess-scene-stage-it";

const DAY_REF = { id: "d".repeat(64), mime: "image/png", size: 111 };
const NIGHT_REF = { id: "n".repeat(64), mime: "image/png", size: 222 };

// Static directory stub — mirrors the shape of the server's session event
// directory; only "scene.set" is a valid topic for this test.
const directory: EventDirectoryLike = {
  listTopics: async () => ["scene.set"],
  validate: async () => ({ ok: true }),
};

// Stand-in for a narrator-type agent runtime: step 1 calls emit-event with
// the given scene.set payload, step 2 returns closing narrative text.
class SceneSetLLM implements LLMAdapter {
  private step = 0;
  constructor(private readonly data: { location: string; timeOfDay: string }) {}
  async generate(): Promise<LLMResponse> {
    this.step++;
    if (this.step === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: "tc-1",
            name: "emit-event",
            arguments: JSON.stringify({ topic: "scene.set", data: this.data }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    return {
      content: "scene noted.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

const emitterManifest: RuntimeManifest = {
  name: "narrator-stub/emitter",
  pluginId: "narrator-stub",
  description: "Test stand-in for a narrator that emits scene.set",
  priority: 500,
  outputKind: "story",
  tools: { builtin: ["emit-event"] },
  trigger: { type: "auto" },
} as RuntimeManifest;

async function loadSceneStageResolver(): Promise<{
  manifest: RuntimeManifest;
  loaded: LoadedRuntime;
}> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const discovery = discoveries.find((d) => d.id === "scene-stage");
  if (!discovery) {
    throw new Error("scene-stage plugin not found under plugins/");
  }
  const parsed = await loadPluginManifest(discovery);
  const resolverParsed = parsed.find(
    (p) => p.manifest.name === "scene-stage/resolver",
  );
  if (!resolverParsed) {
    throw new Error("scene-stage resolver runtime manifest not found");
  }
  const loaded = await loadRuntime(discovery, resolverParsed.manifest.name);
  return { manifest: resolverParsed.manifest, loaded };
}

async function seedRegistry(store: DataStore): Promise<void> {
  const now = new Date().toISOString();
  await store.setPluginData({
    id: `${SESSION_ID}:scene-stage:scenes:scene-registry`,
    sessionId: SESSION_ID,
    pluginId: "scene-stage",
    namespace: "scenes",
    key: "scene-registry",
    value: {
      schemaVersion: 1,
      registryId: "scene-registry",
      style: { prefix: "anime style, ", suffix: ", high detail" },
      scenes: [
        {
          sceneId: "library-01",
          name: "图书馆",
          locationRef: "图书馆",
          day: DAY_REF,
          night: NIGHT_REF,
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  });
}

describe("scene-stage: scene.set → resolver → stage/current (E → B integration)", () => {
  it("resolves a world-registry match same-turn, then switches variant on the next scene.set", async () => {
    const { manifest: resolverManifest, loaded: resolverLoaded } =
      await loadSceneStageResolver();
    const store = createMemoryStore();
    await seedRegistry(store);

    const runTurn = async (
      turnId: string,
      data: { location: string; timeOfDay: string },
    ) => {
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m) =>
          m.name === emitterManifest.name
            ? { manifest: m, promptTemplate: "Emit scene.set via emit-event." }
            : resolverLoaded,
        llm: new SceneSetLLM(data),
        store,
        toolExecutor: createToolExecutor({
          findTool: (name) =>
            name === "emit-event"
              ? createEmitEventTool({ directory })
              : undefined,
          store,
        }),
      };
      const turnInput: TurnInput = {
        sessionId: SESSION_ID,
        turnId,
        playerMessage: "look around",
      };
      const result = await executeTurn(
        turnInput,
        [emitterManifest, resolverManifest],
        deps,
        { maxSteps: 3 },
      );
      const resolverResult = result.runtimeResults.find(
        (r) => r.runtimeId === resolverManifest.name,
      );
      expect(resolverResult?.status).toBe("success");
      await processRuntimeResult(
        resolverResult!,
        store,
        SESSION_ID,
        resolverManifest.outputKind,
        { capabilities: resolverManifest.capabilities },
      );
      return resolverResult!;
    };

    await runTurn("turn-1", { location: "图书馆", timeOfDay: "day" });
    const afterTurn1 = await store.getPluginData(
      SESSION_ID,
      "scene-stage",
      "stage",
      "current",
    );
    expect(afterTurn1?.value).toMatchObject({
      sceneId: "library-01",
      variant: "day",
      source: "world",
      resolved: DAY_REF,
      sourceLabel: { zh: "世界背景", en: "World art" },
    });

    await runTurn("turn-2", { location: "图书馆", timeOfDay: "night" });
    const afterTurn2 = await store.getPluginData(
      SESSION_ID,
      "scene-stage",
      "stage",
      "current",
    );
    expect(afterTurn2?.value).toMatchObject({
      sceneId: "library-01",
      variant: "night",
      source: "world",
      resolved: NIGHT_REF,
      sourceLabel: { zh: "世界背景", en: "World art" },
    });
  });
});
