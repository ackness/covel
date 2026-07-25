/**
 * Setup state-machine unit tests — the mechanisms behind acceptance scenarios
 * 2 and 8, tested in isolation:
 *
 *  - attempt ledger idempotency + "a rolled-back commit still burns an attempt"
 *  - setup session-gate SCC → blocked{setup-session-cycle}
 *  - main-loop dependency-cycle SCC → skipped{dependency-cycle} (no priority
 *    fall-back)
 *  - plugin version mismatch invalidates a prior `done` and bumps the generation
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
  isSetupDoneForVersion,
  mirrorSetupDone,
  resolveSetupGeneration,
  type RanSetupRuntime,
  type RuntimeManifest,
  type SetupRuntimeState,
} from "@covel/shared";
import { settleSetupRuntimes } from "../src/commit/setup-settle.js";
import { detectSetupSessionCycles } from "../src/turn-executor/setup-run.js";
import { selectTriggeredRuntimes } from "../src/turn-executor/scheduling.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

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

async function setupSession(
  store: DataStore,
  id: string,
  setupRuntimes: Record<string, SetupRuntimeState> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: "w",
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes,
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

const ran = (
  overrides: Partial<RanSetupRuntime> & { executionId: string },
): RanSetupRuntime => ({
  runtimeId: "plug/setup",
  pluginVersion: "1.0.0",
  generation: 1,
  startedAt: new Date().toISOString(),
  doneSignal: false,
  ledgerState: "failed",
  budget: 3,
  ...overrides,
});

describe("setup attempt ledger", () => {
  it("counts each executionId once (idempotent re-settle)", async () => {
    const store = createMemoryStore();
    await setupSession(store, "s");
    const now = new Date().toISOString();

    // Same executionId settled twice → one ledger row, attempts stays 1.
    await settleSetupRuntimes({
      store,
      sessionId: "s",
      ran: [ran({ executionId: "e1" })],
      committed: true,
      now,
    });
    await settleSetupRuntimes({
      store,
      sessionId: "s",
      ran: [ran({ executionId: "e1" })],
      committed: true,
      now,
    });

    const rows = await store.listSetupAttempts("s", {
      runtimeId: "plug/setup",
    });
    expect(rows).toHaveLength(1);
    const mirror = (await store.getSession("s"))!.setupRuntimes!["plug/setup"];
    expect(mirror).toMatchObject({ state: "pending", attempts: 1 });
  });

  it("a rolled-back commit still burns the attempt — the ledger is written outside the transaction", async () => {
    const store = createMemoryStore();
    await setupSession(store, "s");
    const now = new Date().toISOString();

    // The runtime reported done, but the commit rolled back (committed: false).
    // The attempt is recorded FAILED (not success) and the mirror is NOT done.
    await settleSetupRuntimes({
      store,
      sessionId: "s",
      ran: [
        ran({ executionId: "e1", doneSignal: true, ledgerState: "success" }),
      ],
      committed: false,
      now,
    });

    const rows = await store.listSetupAttempts("s", {
      runtimeId: "plug/setup",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
    const mirror = (await store.getSession("s"))!.setupRuntimes!["plug/setup"];
    expect(mirror.state).toBe("pending");
    expect((mirror as { attempts: number }).attempts).toBe(1);
  });

  it("blocks once the ledger reaches the budget", async () => {
    const store = createMemoryStore();
    await setupSession(store, "s");
    const now = new Date().toISOString();
    for (const executionId of ["e1", "e2", "e3"]) {
      await settleSetupRuntimes({
        store,
        sessionId: "s",
        ran: [ran({ executionId, budget: 3 })],
        committed: true,
        now,
      });
    }
    const mirror = (await store.getSession("s"))!.setupRuntimes!["plug/setup"];
    expect(mirror.state).toBe("blocked");
    expect((mirror as { attempts: number }).attempts).toBe(3);
    // A blocked setup keeps the session in the setup band.
    expect((await store.getSession("s"))!.phase).toBe("setup");
  });
});

describe("setup session-gate SCC", () => {
  it("detects a needs(scope: session) cycle among pending setup runtimes", () => {
    const x = {
      name: "x/setup",
      pluginId: "x",
      stage: "setup",
      needs: [{ runtime: "y/setup", scope: "session" }],
    } as unknown as RuntimeManifest;
    const y = {
      name: "y/setup",
      pluginId: "y",
      stage: "setup",
      needs: [{ runtime: "x/setup", scope: "session" }],
    } as unknown as RuntimeManifest;
    const z = {
      name: "z/setup",
      pluginId: "z",
      stage: "setup",
    } as RuntimeManifest;

    const cycles = detectSetupSessionCycles([x, y, z]);
    expect(cycles.has("x/setup")).toBe(true);
    expect(cycles.has("y/setup")).toBe(true);
    expect(cycles.has("z/setup")).toBe(false); // acyclic member unaffected
  });

  it("blocks session-cycle members up front (no run, persistent blocked)", async () => {
    const store = createMemoryStore();
    await setupSession(store, "s");
    const x = {
      name: "x/setup",
      pluginId: "x",
      description: "x",
      stage: "setup",
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      needs: [{ runtime: "y/setup", scope: "session" }],
    } as unknown as RuntimeManifest;
    const y = {
      name: "y/setup",
      pluginId: "y",
      description: "y",
      stage: "setup",
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      needs: [{ runtime: "x/setup", scope: "session" }],
    } as unknown as RuntimeManifest;

    const invoked: string[] = [];
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          invoked.push(m.name);
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "" },
      [x, y],
      deps,
    );

    const mirror = (await store.getSession("s"))!.setupRuntimes!;
    expect(mirror["x/setup"]?.state).toBe("blocked");
    expect(mirror["y/setup"]?.state).toBe("blocked");
    expect((mirror["x/setup"] as { reason: string }).reason).toContain(
      "setup-session-cycle",
    );
    // Cycle members never run (no attempt burned).
    expect(invoked).toEqual([]);
  });
});

describe("main-loop dependency-cycle SCC", () => {
  it("disables the cyclic SCC (skipped: dependency-cycle) and runs the rest", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "s",
      worldId: "w",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });

    const inject = (from: string) => ({
      input: {
        inject: [
          { kind: "runtime", from, field: "narrativeOutput", as: "<x>" },
        ],
      },
    });
    const main = (
      name: string,
      priority: number,
      extra: Partial<RuntimeManifest> = {},
    ): RuntimeManifest =>
      ({
        name,
        pluginId: name,
        description: name,
        stage:
          priority <= 99
            ? "setup"
            : priority <= 499
              ? "pre-turn"
              : priority === 500
                ? "narrative"
                : priority <= 999
                  ? "post-turn"
                  : "audit",
        runtimeType: "function",
        handler: "./h.js",
        trigger: { type: "auto" },
        outputKind: "plugin",
        capabilities: [],
        ...extra,
      }) as RuntimeManifest;

    // a ⇄ b cycle; c independent. All post-turn (same stage) so the cycle sits
    // inside one stage's DAG — a cross-stage cycle is not a cycle, since the
    // stage barrier already orders the two runtimes.
    const a = main("a", 600, inject("b"));
    const b = main("b", 600, inject("a"));
    const c = main("c", 600);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => ({}),
      }),
      llm: new NoopLLM(),
      store,
    };
    const result = await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      [a, b, c],
      deps,
    );
    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("a")?.status).toBe("skipped");
    expect(byId.get("a")?.output).toMatchObject({
      reason: "dependency-cycle",
      skippedBy: "framework:dependencyCycle",
    });
    expect(byId.get("b")?.status).toBe("skipped");
    // The acyclic remainder still runs — no fall-back to a plain priority sort.
    expect(byId.get("c")?.status).toBe("success");
  });
});

describe("plugin version mismatch", () => {
  it("invalidates a prior done and bumps the generation", () => {
    const doneV1 = mirrorSetupDone("1.0.0", new Date().toISOString());
    expect(isSetupDoneForVersion(doneV1, "1.0.0")).toBe(true);
    expect(isSetupDoneForVersion(doneV1, "2.0.0")).toBe(false);
    // Same version reuses the generation; a bump starts a fresh one.
    expect(resolveSetupGeneration("1.0.0", doneV1)).toBe(1);
    expect(resolveSetupGeneration("2.0.0", doneV1)).toBe(2);
    expect(resolveSetupGeneration("1.0.0", undefined)).toBe(1);
  });

  it("re-runs a done setup runtime whose plugin version changed", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    // Playing session; the setup runtime is already done at version 1.0.0.
    await store.createSession({
      id: "s",
      worldId: "w",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: { "plug/setup": mirrorSetupDone("1.0.0", now) },
      activePlugins: ["plug"],
      createdAt: now,
      updatedAt: now,
    });
    // Active manifest is version 2.0.0 → mismatch → must re-run.
    const setup = {
      name: "plug/setup",
      pluginId: "plug",
      description: "setup",
      version: "2.0.0",
      stage: "setup",
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
    } as RuntimeManifest;

    let ranCount = 0;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          ranCount += 1;
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    const result = await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      [setup],
      deps,
    );
    expect(ranCount).toBe(1);
    // The ledger entry is stamped with the bumped generation (2).
    expect(result.setupRan?.[0]).toMatchObject({
      runtimeId: "plug/setup",
      generation: 2,
      pluginVersion: "2.0.0",
    });
  });
});

describe("needs(scope: session) positive gate (setup selection)", () => {
  const setupRt = (
    name: string,
    extra: Record<string, unknown> = {},
  ): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      description: name,
      stage: "setup",
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      version: "1.0.0",
      ...extra,
    }) as unknown as RuntimeManifest;

  const select = (
    runtimes: readonly RuntimeManifest[],
    setupRuntimes: Record<string, SetupRuntimeState> = {},
  ) =>
    selectTriggeredRuntimes({
      activeRuntimes: runtimes,
      manualRuntimeId: undefined,
      messageHistory: [],
      preGameCompleted: [],
      runtimeTriggerCounts: new Map(),
      setupRuntimes,
      sessionId: "s-gate",
      turnNumber: 0,
      logicalTurn: 1,
    }).triggered.map((rt) => rt.name);

  it("holds the consumer back while the producer is not done in the frozen snapshot", () => {
    const producer = setupRt("prod/setup");
    const consumer = setupRt("cons/setup", {
      needs: [{ runtime: "prod/setup", scope: "session" }],
    });

    // Producer pending → consumer NOT selected this execution.
    expect(select([producer, consumer])).toEqual(["prod/setup"]);
  });

  it("selects the consumer once the producer is done in the snapshot", () => {
    const producer = setupRt("prod/setup");
    const consumer = setupRt("cons/setup", {
      needs: [{ runtime: "prod/setup", scope: "session" }],
    });
    const now = new Date().toISOString();

    // Producer done (and therefore itself no longer pending) → consumer runs.
    expect(
      select([producer, consumer], {
        "prod/setup": mirrorSetupDone("1.0.0", now),
      }),
    ).toEqual(["cons/setup"]);
  });

  it("capability gate with cardinality 'all' waits for every provider", () => {
    const p1 = setupRt("p1/setup", { capabilities: ["world-seed"] });
    const p2 = setupRt("p2/setup", { capabilities: ["world-seed"] });
    const consumer = setupRt("cons/setup", {
      needs: [
        { capability: "world-seed", cardinality: "all", scope: "session" },
      ],
    });
    const now = new Date().toISOString();

    // One of two providers done → 'all' gate still closed.
    expect(
      select([p1, p2, consumer], { "p1/setup": mirrorSetupDone("1.0.0", now) }),
    ).toEqual(["p2/setup"]);
    // Both done → gate opens.
    expect(
      select([p1, p2, consumer], {
        "p1/setup": mirrorSetupDone("1.0.0", now),
        "p2/setup": mirrorSetupDone("1.0.0", now),
      }),
    ).toEqual(["cons/setup"]);
  });

  it("capability gate with default cardinality 'one' opens on any done provider", () => {
    const p1 = setupRt("p1/setup", { capabilities: ["world-seed"] });
    const p2 = setupRt("p2/setup", { capabilities: ["world-seed"] });
    const consumer = setupRt("cons/setup", {
      needs: [{ capability: "world-seed", scope: "session" }],
    });
    const now = new Date().toISOString();

    expect(
      select([p1, p2, consumer], { "p1/setup": mirrorSetupDone("1.0.0", now) }),
    ).toEqual(expect.arrayContaining(["p2/setup", "cons/setup"]));
  });

  it("an absent target never satisfies the gate (consumer held back, warned once)", () => {
    const consumer = setupRt("cons/setup", {
      needs: [{ runtime: "ghost/setup", scope: "session" }],
    });
    expect(select([consumer])).toEqual([]);
  });

  it("turn-scope needs do not participate in the session gate", () => {
    const producer = setupRt("prod/setup");
    const consumer = setupRt("cons/setup", {
      needs: ["prod/setup", { runtime: "prod/setup", scope: "turn" }],
    });

    // Same-execution gates are the upstream gate's job — both stay selected.
    expect(select([producer, consumer])).toEqual(["prod/setup", "cons/setup"]);
  });
});
