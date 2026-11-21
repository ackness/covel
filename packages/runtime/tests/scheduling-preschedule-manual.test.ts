/**
 * Regression tests for PreSchedule hook filtering on manual triggers and batch
 * recovery executions (`packages/runtime/src/turn-executor/scheduling.ts`).
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  TurnInput,
} from "@covel/shared";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { scheduleTriggeredRuntimes } from "../src/turn-executor/scheduling.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function fnManifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "post-turn",
    outputKind: "system",
    runtimeType: "function",
    handler: "./handler.js",
    trigger: { type: "auto" },
    ...overrides,
  };
}

async function createPlayingStore(
  sessionId: string,
  activePlugins: readonly string[],
) {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  await store.createSession({
    id: sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [...activePlugins],
    completedPlayerTurns: 1,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

describe("scheduleTriggeredRuntimes PreSchedule filtering", () => {
  it("schedules only triggered runtimes across all stages when manualTargets is set", () => {
    const pre = fnManifest("p/pre", { stage: "pre-turn" });
    const post = fnManifest("p/post", { stage: "post-turn" });
    const unstaged = fnManifest("p/unstaged", { stage: undefined });

    const narrowed = scheduleTriggeredRuntimes({
      manualTarget: undefined,
      manualTargets: [pre, post, unstaged],
      triggered: [unstaged, pre],
      isPreGamePending: false,
    });

    expect(
      narrowed.groups.map((group) => group.runtimes.map((rt) => rt.name)),
    ).toEqual([["p/pre"], ["p/unstaged"]]);
    expect(narrowed.cyclic).toEqual([]);

    const empty = scheduleTriggeredRuntimes({
      manualTarget: undefined,
      manualTargets: [pre, post],
      triggered: [],
      isPreGamePending: false,
    });
    expect(empty).toEqual({ groups: [], cyclic: [] });
  });

  it("omits manualTarget when PreSchedule removes it from triggered", () => {
    const target = fnManifest("p/target", { trigger: { type: "manual" } });

    expect(
      scheduleTriggeredRuntimes({
        manualTarget: target,
        triggered: [target],
        isPreGamePending: false,
      }),
    ).toEqual({ groups: [{ runtimes: [target] }], cyclic: [] });

    expect(
      scheduleTriggeredRuntimes({
        manualTarget: target,
        triggered: [],
        isPreGamePending: false,
      }),
    ).toEqual({ groups: [], cyclic: [] });
  });
});

describe("runTurnPipeline PreSchedule filtering on manual & batch recovery", () => {
  it("suppresses a manual trigger when PreSchedule returns replace.triggered: []", async () => {
    const target = fnManifest("plug/target", { trigger: { type: "manual" } });
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "plug:PreSchedule:suppress",
      pluginId: "plug",
      event: "PreSchedule",
      handler: async () => ({
        action: "continue",
        replace: { triggered: [] },
      }),
    });

    const store = await createPlayingStore("sess-manual-suppress", ["plug"]);
    const input: TurnInput = {
      origin: "manual",
      sessionId: "sess-manual-suppress",
      turnId: "turn-1",
      playerMessage: "",
      manualTrigger: { runtimeId: target.name },
    };

    const result = await runTurnPipeline(input, [target], {
      store,
      llm: new NoopLLM(),
      hookPipeline,
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        handler,
      }),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.runtimeResults).toEqual([]);
  });

  it("keeps detached manual trigger consistent with detachment planning when PreSchedule suppresses it", async () => {
    const detachedTarget = fnManifest("plug/detached", {
      trigger: { type: "manual" },
      effects: { writes: ["media:*"] },
      turnCompletion: { mode: "detached" },
    });
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "plug:PreSchedule:suppress-detached",
      pluginId: "plug",
      event: "PreSchedule",
      handler: async () => ({
        action: "continue",
        replace: { triggered: [] },
      }),
    });

    const store = await createPlayingStore("sess-manual-detached", ["plug"]);
    const result = await runTurnPipeline(
      {
        origin: "manual",
        sessionId: "sess-manual-detached",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: detachedTarget.name },
      },
      [detachedTarget],
      {
        store,
        llm: new NoopLLM(),
        hookPipeline,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler,
        }),
      },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result.runtimeResults).toEqual([]);
    expect(result.deferredRuntimeJobs ?? []).toEqual([]);
  });

  it("narrows a batch recovery execution according to PreSchedule replacement", async () => {
    const first = fnManifest("plug/first", { stage: "pre-turn" });
    const second = fnManifest("plug/second", { stage: "post-turn" });
    const calls: string[] = [];
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "plug:PreSchedule:narrow-batch",
      pluginId: "plug",
      event: "PreSchedule",
      handler: async (
        _ctx,
        payload: { triggered: readonly RuntimeManifest[] },
      ) => ({
        action: "continue",
        replace: {
          triggered: payload.triggered.filter((rt) => rt.name === first.name),
        },
      }),
    });

    const store = await createPlayingStore("sess-batch-narrow", ["plug"]);
    const result = await runTurnPipeline(
      {
        origin: "manual",
        sessionId: "sess-batch-narrow",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: {
          runtimeIds: [second.name, first.name],
          sourceTurnId: "source-turn",
        },
      },
      [first, second],
      {
        store,
        llm: new NoopLLM(),
        hookPipeline,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => {
            calls.push(manifest.name);
            return { outcome: "success", value: { ok: true } };
          },
        }),
      },
    );

    expect(calls).toEqual([first.name]);
    expect(result.runtimeResults.map((rr) => rr.runtimeId)).toEqual([
      first.name,
    ]);
  });

  it("suppresses an entire batch recovery when PreSchedule returns replace.triggered: []", async () => {
    const first = fnManifest("plug/first");
    const second = fnManifest("plug/second");
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "plug:PreSchedule:empty-batch",
      pluginId: "plug",
      event: "PreSchedule",
      handler: async () => ({
        action: "continue",
        replace: { triggered: [] },
      }),
    });

    const store = await createPlayingStore("sess-batch-empty", ["plug"]);
    const result = await runTurnPipeline(
      {
        origin: "manual",
        sessionId: "sess-batch-empty",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: {
          runtimeIds: [first.name, second.name],
          sourceTurnId: "source-turn",
        },
      },
      [first, second],
      {
        store,
        llm: new NoopLLM(),
        hookPipeline,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler,
        }),
      },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result.runtimeResults).toEqual([]);
  });
});
