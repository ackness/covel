/**
 * Agent-guard deadline (audit R-12).
 *
 * `executeAgentGuard` used to await `loaded.guard(...)` with no deadline and
 * no abort signal — a hung guard blocked the turn (and the session lock)
 * forever. These tests pin the Promise.race deadline (mirroring the
 * function-runtime handler pattern) and the turnControl signal pass-through.
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

function makeAgentManifest(
  overrides?: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name: "guarded-agent",
    pluginId: "guarded-agent",
    pluginType: "community",
    priority: 500,
    trigger: { type: "auto" },
    model: "gpt-4o-mini",
    runtimeType: "agent",
    ...overrides,
  };
}

function makeTurnInput(): TurnInput {
  return {
    sessionId: "sess-guard",
    turnId: "turn-guard",
    playerMessage: "hi",
  };
}

const baseLLM = {
  generate: vi.fn().mockResolvedValue({
    content: "story",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

function makeDeps(
  loaded: LoadedRuntime,
  extra?: Partial<TurnExecutorDeps>,
): TurnExecutorDeps {
  return {
    loadRuntime: async () => loaded,
    llm: baseLLM,
    getConfig: () => ({}),
    ...extra,
  } as TurnExecutorDeps;
}

describe("agent guard deadline (R-12)", () => {
  it("fails the runtime when the guard exceeds manifest.timeoutMs instead of hanging the turn", async () => {
    const loaded: LoadedRuntime = {
      manifest: makeAgentManifest({ timeoutMs: 50 }),
      promptTemplate: "prompt",
      guard: async () => {
        await new Promise(() => {}); // never settles — simulates a hung guard
        return {};
      },
    };

    const result = await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded),
    );

    const rt = result.runtimeResults[0]!;
    expect(rt.status).toBe("failed");
    expect(String(rt.error)).toContain("timed out after 50ms");
  });

  it("passes the turnControl abort signal to the guard", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const loaded: LoadedRuntime = {
      manifest: makeAgentManifest(),
      promptTemplate: "prompt",
      guard: async (ctx) => {
        seenSignal = ctx.signal;
        return { skip: true, reason: "test" };
      },
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { turnControl: { signal: controller.signal } }),
    );

    expect(seenSignal).toBe(controller.signal);
  });
});
