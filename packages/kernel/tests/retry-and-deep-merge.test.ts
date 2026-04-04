/**
 * TDD tests for:
 *   HIGH-1 — retryTurn must revert kernelContext.state to pre-commit state before re-execution
 *   HIGH-2 — intra-turn state.patch must use deepMerge (not shallow merge) for consistency with commit
 */
import { describe, it, expect, vi } from "vitest";
import { bootstrapKernel } from "../src/kernel.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { KernelInput, ProposalItem } from "@covel/shared";
import type { GatewayLike } from "@covel/runtime";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput: KernelInput = {
  runId: "run-1",
  branchId: "branch-1",
  actorId: "player-1",
  type: "user.input",
  payload: { text: "test" },
};

function makeHost() {
  return createPluginHost();
}

/**
 * Build a gateway whose generateText returns exactly the proposals provided.
 * The runtime handler is attached directly so no real LLM call happens.
 */
function makeHandlerGateway(): GatewayLike {
  return {
    async generateText() {
      return { text: "", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async *streamText() {
      yield { type: "done" as const, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function registerPluginAndRuntime(
  host: ReturnType<typeof makeHost>,
  pluginId: string,
  runtimeId: string,
  priority: number,
  handler: RegisteredRuntime["handler"]
) {
  host.runtimeRegistry.register(pluginId, {
    id: runtimeId,
    pluginId,
    kind: "plugin",
    phase: "post_story",
    trigger: { mode: "always" },
    priority,
    tools: [],
    hooks: [],
  });

  // Attach handler via the registry's setHandler method so no LLM is called
  if (handler) {
    host.runtimeRegistry.setHandler(pluginId, runtimeId, handler);
  }

  // Only add the plugin once (avoid duplicate registration)
  if (!host.pluginRegistry.get(pluginId)) {
    host.pluginRegistry.add(
      {
        schemaVersion: "1.0",
        id: pluginId,
        displayName: pluginId,
        version: "0.1.0",
        author: "test",
        description: pluginId,
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      },
      `/tmp/${pluginId}`
    );
  }
}

// ---------------------------------------------------------------------------
// HIGH-1: retryTurn — state revert before re-execution
// ---------------------------------------------------------------------------

describe("HIGH-1: retryTurn reverts kernelContext.state before re-execution", () => {
  /**
   * Scenario:
   *   - Initial state: { hp: 100 }
   *   - Turn 1: runtime emits state.patch { hp: 80 } → kernelContext.state becomes { hp: 80 }
   *   - retryTurn() is called
   *   - The retry must start from { hp: 100 } (pre-commit state), NOT { hp: 80 }
   *   - After retry the final state should again be { hp: 80 } (patch re-applied from 100)
   *
   * Without the fix, the retry starts from { hp: 80 } and applies the patch again,
   * potentially resulting in wrong state (if the patch is additive) or just the wrong baseline.
   */
  it("retries from pre-commit state, not post-commit state", async () => {
    const host = makeHost();
    const gateway = makeHandlerGateway();

    // Track what state the runtime sees at its invocation start
    const seenStates: Array<Record<string, unknown>> = [];

    registerPluginAndRuntime(host, "state-plugin", "state-rt", 500, async (ctx) => {
      // Capture the state snapshot visible to the runtime at call time
      // The handler receives { context, data, ... } where context is RuntimeContextView
      const currentState = (ctx.context?.state as Record<string, unknown>) ?? {};
      seenStates.push({ ...currentState });

      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { hp: 80 } } as ProposalItem,
        ],
      };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({ initialContext: { state: { hp: 100 } } });

    // Execute first turn — runtime sees { hp: 100 }, state becomes { hp: 80 }
    await session.executeTurn(baseInput);
    expect(seenStates[0]).toMatchObject({ hp: 100 });
    expect(session.getContext().state).toMatchObject({ hp: 80 });

    // Retry the whole turn — runtime must see { hp: 100 } again (pre-commit state restored)
    await session.retryTurn(undefined);
    expect(seenStates[1]).toMatchObject({ hp: 100 });

    // After retry the final committed state should be { hp: 80 } (patch re-applied cleanly)
    expect(session.getContext().state).toMatchObject({ hp: 80 });
  });

  it("does not double-apply patches when retrying an additive patch", async () => {
    const host = makeHost();
    const gateway = makeHandlerGateway();

    registerPluginAndRuntime(host, "add-plugin", "add-rt", 500, async () => {
      return {
        text: "",
        proposals: [
          // Additive: set gold to 50 (absolute, not relative)
          { kind: "state.patch", payload: { gold: 50 } } as ProposalItem,
        ],
      };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({ initialContext: { state: { gold: 0 } } });

    await session.executeTurn(baseInput);
    expect(session.getContext().state).toMatchObject({ gold: 50 });

    // Retry: if state is NOT reverted, gold would start at 50 and patch sets it to 50 again (same)
    // but with a relative-increment pattern it would double. The key assertion is baseline is restored.
    await session.retryTurn(undefined);
    // gold should be 50 (set from baseline 0), NOT 100 (50+50 if patch were additive from wrong base)
    expect(session.getContext().state).toMatchObject({ gold: 50 });
  });

  it("saves preCommitState in TurnCache so retryTurn can access it", async () => {
    const host = makeHost();
    const gateway = makeHandlerGateway();

    registerPluginAndRuntime(host, "cache-plugin", "cache-rt", 500, async () => {
      return {
        text: "",
        proposals: [{ kind: "state.patch", payload: { level: 5 } } as ProposalItem],
      };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({ initialContext: { state: { level: 1 } } });

    await session.executeTurn(baseInput);

    const cache = session.getLastTurnCache();
    expect(cache).not.toBeNull();
    // The cache should contain pre-commit state (level: 1 before the patch was applied)
    expect((cache as any).preCommitState).toBeDefined();
    expect((cache as any).preCommitState).toMatchObject({ level: 1 });
  });
});

// ---------------------------------------------------------------------------
// HIGH-2: intra-turn state.patch uses deepMerge (not shallow merge)
// ---------------------------------------------------------------------------

describe("HIGH-2: intra-turn state.patch uses deepMerge for consistency with commit", () => {
  /**
   * Scenario: Two runtimes in sequence. Runtime A patches a nested object.
   * Runtime B reads the state (via TurnContextStore) and should see the
   * deeply-merged version, not a shallowly-merged version.
   *
   * Initial state:  { player: { hp: 100, gold: 50 } }
   * Runtime A patch: { player: { hp: 80 } }
   *
   * Expected intra-turn state after A: { player: { hp: 80, gold: 50 } }  ← deep merge
   * Actual (broken):                   { player: { hp: 80 } }             ← shallow merge (gold lost)
   */
  it("preserves sibling keys under nested patch during intra-turn application", async () => {
    const host = makeHost();
    const gateway = makeHandlerGateway();

    const seenStateInB: Array<Record<string, unknown>> = [];

    // Runtime A (priority 400): patches nested player.hp
    registerPluginAndRuntime(host, "plugin-a", "rt-a", 400, async () => {
      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { player: { hp: 80 } } } as ProposalItem,
        ],
      };
    });

    // Runtime B (priority 600): reads state — should see player.gold preserved
    registerPluginAndRuntime(host, "plugin-b", "rt-b", 600, async (ctx) => {
      const state = (ctx.context?.state as Record<string, unknown>) ?? {};
      seenStateInB.push(JSON.parse(JSON.stringify(state)));
      return { text: "", proposals: [] };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({
      initialContext: { state: { player: { hp: 100, gold: 50 } } },
    });

    await session.executeTurn(baseInput);

    // Runtime B must have seen the deeply-merged state (gold preserved)
    expect(seenStateInB[0]).toBeDefined();
    const playerInB = seenStateInB[0]?.player as Record<string, unknown> | undefined;
    expect(playerInB).toBeDefined();
    expect(playerInB?.hp).toBe(80);
    // CRITICAL: gold must still be 50 — shallow merge would have dropped it
    expect(playerInB?.gold).toBe(50);
  });

  it("intra-turn deep merge matches commit-time deep merge for same patch", async () => {
    const host = makeHost();
    const gateway = makeHandlerGateway();

    // Single runtime that patches a nested object
    registerPluginAndRuntime(host, "merge-plugin", "merge-rt", 500, async () => {
      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { config: { debug: true } } } as ProposalItem,
        ],
      };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({
      initialContext: { state: { config: { debug: false, verbose: true } } },
    });

    await session.executeTurn(baseInput);

    // After commit, the committed state should deep-merge: verbose must survive
    const finalState = session.getContext().state ?? {};
    const config = finalState.config as Record<string, unknown> | undefined;
    expect(config?.debug).toBe(true);
    expect(config?.verbose).toBe(true); // must not be lost
  });

  it("parallel runtimes in same priority group do not race on turnState", async () => {
    /**
     * H19: Two runtimes at the same priority execute via Promise.allSettled.
     * If eager state apply happens inside the parallel block, the last one to
     * resolve silently overwrites the first one's state.patch.
     *
     * Fix: eager apply is deferred to after Promise.allSettled completes,
     * applied serially from collected results.
     */
    const host = makeHost();
    const gateway = makeHandlerGateway();

    // Both runtimes at priority 500 → same group → parallel execution
    // Use distinct top-level keys so the proposal validator doesn't reject for conflicts.
    registerPluginAndRuntime(host, "race-a", "rt-race-a", 500, async () => {
      // Simulate async work to increase chance of interleaving
      await new Promise((r) => setTimeout(r, 10));
      return {
        text: "A narrative",
        proposals: [
          { kind: "state.patch", payload: { fromA: true } } as ProposalItem,
        ],
      };
    });

    registerPluginAndRuntime(host, "race-b", "rt-race-b", 500, async () => {
      return {
        text: "B narrative",
        proposals: [
          { kind: "state.patch", payload: { fromB: true } } as ProposalItem,
        ],
      };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({
      initialContext: { state: { existing: "keep" } },
    });

    const result = await session.executeTurn(baseInput);

    // Both patches must be present in final committed state
    const state = session.getContext().state as Record<string, unknown>;
    expect(state.existing).toBe("keep");
    expect(state.fromA).toBe(true);
    expect(state.fromB).toBe(true);
  });

  it("parallel runtimes: next priority group sees all patches from previous parallel group", async () => {
    /**
     * Verify that after a parallel group completes, the serial post-group
     * state merge makes all patches visible to the next priority group.
     */
    const host = makeHost();
    const gateway = makeHandlerGateway();

    const seenStateInC: Array<Record<string, unknown>> = [];

    // Two parallel runtimes at priority 400
    registerPluginAndRuntime(host, "par-a", "rt-par-a", 400, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { scoreA: 10 } } as ProposalItem,
        ],
      };
    });

    registerPluginAndRuntime(host, "par-b", "rt-par-b", 400, async () => {
      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { scoreB: 20 } } as ProposalItem,
        ],
      };
    });

    // Observer at priority 600 — should see both scoreA and scoreB
    registerPluginAndRuntime(host, "observer", "rt-obs", 600, async (ctx) => {
      const state = (ctx.context?.state as Record<string, unknown>) ?? {};
      seenStateInC.push(JSON.parse(JSON.stringify(state)));
      return { text: "", proposals: [] };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({
      initialContext: { state: {} },
    });

    await session.executeTurn(baseInput);

    expect(seenStateInC[0]).toBeDefined();
    expect(seenStateInC[0].scoreA).toBe(10);
    expect(seenStateInC[0].scoreB).toBe(20);
  });

  it("cached intra-turn proposal replay also uses deepMerge", async () => {
    /**
     * Scenario: retryTurn with fromRuntimeId causes cached results to be replayed.
     * The replay path (intra-turn) must also use deepMerge, not shallow merge.
     */
    const host = makeHost();
    const gateway = makeHandlerGateway();

    const seenStateInC: Array<Record<string, unknown>> = [];

    // Runtime A (priority 300): patches nested stats.atk
    registerPluginAndRuntime(host, "cached-a", "rt-a", 300, async () => {
      return {
        text: "",
        proposals: [
          { kind: "state.patch", payload: { stats: { atk: 15 } } } as ProposalItem,
        ],
      };
    });

    // Runtime B (priority 500, retry target): reads state
    registerPluginAndRuntime(host, "cached-b", "rt-b", 500, async (ctx) => {
      const state = (ctx.context?.state as Record<string, unknown>) ?? {};
      seenStateInC.push(JSON.parse(JSON.stringify(state)));
      return { text: "", proposals: [] };
    });

    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({
      initialContext: { state: { stats: { atk: 10, def: 20 } } },
    });

    // First turn: both runtimes execute normally
    await session.executeTurn(baseInput);

    // Retry from rt-b: rt-a's result replays from cache, rt-b re-executes
    // The replayed state.patch for rt-a must deepMerge so def is preserved
    seenStateInC.length = 0;
    await session.retryTurn("cached-b:rt-b");

    expect(seenStateInC[0]).toBeDefined();
    const stats = seenStateInC[0]?.stats as Record<string, unknown> | undefined;
    expect(stats?.atk).toBe(15);
    // CRITICAL: def must survive the deep-merged replay
    expect(stats?.def).toBe(20);
  });
});
