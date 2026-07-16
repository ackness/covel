/**
 * Agent-guard deadline (audit R-12) and post-deadline write revocation
 * (re-review H-11).
 *
 * `executeAgentGuard` used to await `loaded.guard(...)` with no deadline and
 * no abort signal — a hung guard blocked the turn (and the session lock)
 * forever. These tests pin the Promise.race deadline (mirroring the
 * function-runtime handler pattern), the abort-signal wiring, and the H-11
 * guarantee: once the deadline fires, the still-running guard's write
 * capabilities (store / pluginData / recursiveCall / …) throw instead of
 * mutating state that now belongs to a later turn.
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
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

  it("propagates the turnControl abort into the guard's signal", async () => {
    // H-11: the guard now receives a COMBINED signal (player turn abort OR
    // the guard's own deadline), so identity with turnControl.signal is no
    // longer expected — abort propagation is.
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

    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    controller.abort();
    expect(seenSignal!.aborted).toBe(true);
  });

  it("revokes a timed-out guard's write capabilities and aborts its signal (H-11)", async () => {
    const store: DataStore = createMemoryStore();
    const setPluginData = vi.spyOn(store, "setPluginData");

    const observed: {
      writeError?: string;
      recursiveError?: string;
      signalAborted?: boolean;
    } = {};
    let guardDone!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      guardDone = resolve;
    });

    const loaded: LoadedRuntime = {
      manifest: makeAgentManifest({ timeoutMs: 30 }),
      promptTemplate: "prompt",
      guard: async (ctx) => {
        // Outlive the 30ms deadline, then attempt late writes — the exact
        // race a timed-out guard runs against a LATER turn.
        await new Promise((resolve) => setTimeout(resolve, 90));
        observed.signalAborted = ctx.signal?.aborted;
        try {
          await ctx.pluginData?.set("ns", "late", { v: 1 });
        } catch (err) {
          observed.writeError =
            err instanceof Error ? err.message : String(err);
        }
        try {
          await ctx.recursiveCall({ playerMessage: "late turn" });
        } catch (err) {
          observed.recursiveError =
            err instanceof Error ? err.message : String(err);
        }
        guardDone();
        return {};
      },
    };

    const result = await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { store, getPluginSource: () => "builtin" }),
    );
    expect(result.runtimeResults[0]!.status).toBe("failed");

    // The guard keeps running past the deadline — wait for it, then verify
    // every late mutation was rejected and nothing reached the store.
    await guardFinished;
    expect(observed.signalAborted).toBe(true);
    expect(observed.writeError).toContain("write capability revoked");
    expect(observed.recursiveError).toContain("write capability revoked");
    expect(setPluginData).not.toHaveBeenCalled();
  });

  it("revokes utility calls as soon as the player aborts the turn", async () => {
    const controller = new AbortController();
    const fetchWithRetry = vi.fn(async () => new Response("ok"));
    let utilityError: string | undefined;
    let entered!: () => void;
    const guardEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueGuard!: () => void;
    const continuePromise = new Promise<void>((resolve) => {
      continueGuard = resolve;
    });
    const loaded: LoadedRuntime = {
      manifest: makeAgentManifest(),
      promptTemplate: "prompt",
      guard: async (ctx) => {
        entered();
        await continuePromise;
        try {
          await ctx.utils?.fetchWithRetry("https://example.com");
        } catch (err) {
          utilityError = err instanceof Error ? err.message : String(err);
        }
        return { skip: true, reason: "aborted" };
      },
    };

    const turn = executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, {
        turnControl: { signal: controller.signal },
        getPluginSource: () => "builtin",
        utils: {
          validateBaseUrl: () => ({ ok: true }),
          fetchWithRetry,
        },
      }),
    );
    await guardEntered;
    controller.abort(new Error("player aborted"));
    continueGuard();
    await turn;

    expect(utilityError).toContain("write capability revoked");
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
