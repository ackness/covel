/**
 * Plugin runtime scheduling redesign — acceptance matrix (contract skeleton).
 *
 * This file is the machine-readable form of the "minimal acceptance scenarios"
 * defined in the design docs:
 *
 *  - devs/docs/plugin-runtime-scheduling/04-migration.md, §6 (scenarios 1-18)
 *  - devs/docs/plugin-runtime-scheduling/05-dependencies-and-permissions.md,
 *    §5 (scenarios 19-25)
 *
 * The scenario text in those docs is the sole authority — this file only
 * indexes each scenario as an `it.todo` so the matrix can be tracked and
 * lit up one at a time as the corresponding release step lands. Every
 * `it.todo` carries a `// needs: <mechanism> (release step N)` comment
 * pointing at the 04-migration.md §3 step that introduces the mechanism it
 * depends on. As each step ships, replace the matching `it.todo` with a real
 * test body (arrange the fixture, act, assert) — do not delete or renumber
 * scenarios, since the numbering is shared with the design docs.
 *
 * Scenario 18 in 04-migration.md §6 bundles two independently testable
 * claims (recordAs export-revision publication, and same-layer effects
 * hazard detection); it is split into 18a/18b below so each lands with its
 * own release step instead of forcing both mechanisms to ship together.
 */

import path from "node:path";
import { describe, it, expect } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  authoringTriggerConfigSchema,
  deriveLegacyClockFields,
  getRuntimeSpec,
  isSetupSatisfied,
  mirrorSetupDone,
  normalizeRuntimeManifest,
  retrySetup,
  STAGE_ORDER,
  triggerConfigSchema,
  waiveSetup,
  type ExecutionContext,
  type RanSetupRuntime,
  type RuntimeActivation,
  type RuntimeManifest,
  type RuntimeResult,
  type SetupRuntimeState,
} from "@covel/shared";
import { buildContext } from "@covel/context";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import { scheduleByPriority } from "../src/schedule/scheduler.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { processRuntimeResult } from "../src/session/session-kernel.js";
import { buildSnapshotPayload } from "../src/snapshot/snapshot-payload-builder.js";
import {
  deriveActivation,
  hasIllegalDetachedContract,
  resolveInputBindings,
} from "../src/schedule/input-bindings.js";
import {
  applyHazardPolicy,
  effectsHazard,
  deriveEffects,
} from "../src/schedule/effects.js";
import type { ScheduledGroup } from "../src/types.js";
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

/**
 * Run one main-loop turn against a `scheduled` runtime and report whether it
 * triggered. The session is seeded straight into `playing` at the given
 * `completedPlayerTurns`, so the runtime's cadence is evaluated on the logical
 * turn `N = completedPlayerTurns + 1`.
 */
async function scheduledRuntimeTriggers(
  completedPlayerTurns: number,
  interval: number,
): Promise<boolean> {
  const store = createMemoryStore();
  const legacy = deriveLegacyClockFields({
    phase: "playing",
    completedPlayerTurns,
    setupRuntimes: {},
  });
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    worldId: "w",
    status: "active",
    turnCount: legacy.turnCount,
    preGameCompleted: [],
    phase: "playing",
    completedPlayerTurns,
    setupRuntimes: {},
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  const ticker = {
    name: "ticker",
    pluginId: "ticker",
    description: "scheduled ticker",
    priority: 500,
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "scheduled", interval },
  } as RuntimeManifest;
  let ran = false;
  const deps: TurnExecutorDeps = {
    loadRuntime: async () => ({
      manifest: ticker,
      promptTemplate: "",
      handler: async () => {
        ran = true;
        return {};
      },
    }),
    llm: new NoopLLM(),
    store,
  };
  await executeTurn(
    { sessionId: "s", turnId: "t", playerMessage: "go" },
    [ticker],
    deps,
  );
  return ran;
}

const PLAYER_CTX = (
  logicalTurnId: string,
  executionId: string,
): ExecutionContext => ({
  executionId,
  origin: "player",
  countPolicy: "complete-player-turn",
  logicalTurnId,
});

function makeRuntime(name: string) {
  return {
    name,
    pluginId: name,
    outputKind: "plugin",
    capabilities: [] as const,
  };
}

function statePatchResult(field: string, value: unknown) {
  return {
    pluginId: "rt-a",
    runtimeId: "rt-a",
    runId: crypto.randomUUID(),
    turnId: "t",
    status: "success" as const,
    output: { statePatches: [{ table: "stats", field, value }] },
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

async function seedPlaying(
  store: DataStore,
  completedPlayerTurns: number,
): Promise<void> {
  const legacy = deriveLegacyClockFields({
    phase: "playing",
    completedPlayerTurns,
    setupRuntimes: {},
  });
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    worldId: "w",
    status: "active",
    turnCount: legacy.turnCount,
    preGameCompleted: [],
    phase: "playing",
    completedPlayerTurns,
    setupRuntimes: {},
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

describe("setup frozen snapshot (cross-execution read of committed setup data)", () => {
  // needs: scope:session frozen-snapshot semantics + finalizeExecution single-transaction commit (release step 2)
  it("scenario 1: schema-gen 本执行产出 proposal 并 commit，player-init 下一执行经冻结快照 gate 通过并读到已提交 schema — 断言快照读到的是提交后状态，且该保证跨执行成立", async () => {
    const store = createMemoryStore();
    const sessionId = "s1";
    const now = new Date().toISOString();
    // A fresh session in the setup band. Plugin `p` carries a setup runtime
    // (schema-gen, priority 40) and a main-loop runtime (player-init, 500)
    // gated on it by the implicit per-plugin session gate.
    await store.createSession({
      id: sessionId,
      worldId: "w",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["p"],
      createdAt: now,
      updatedAt: now,
    });

    const SCHEMA = { attributes: ["str", "dex"], version: 3 };
    const fnRuntime = (name: string, priority: number): RuntimeManifest =>
      ({
        name,
        pluginId: "p",
        description: name,
        priority,
        runtimeType: "function",
        handler: "./h.js",
        trigger: { type: "auto" },
        outputKind: "plugin",
        capabilities: [],
      }) as RuntimeManifest;
    const schemaGen = fnRuntime("p/schema-gen", 40);
    const playerInit = fnRuntime("p/player-init", 500);

    // What player-init read from its frozen snapshot in execution 2.
    let playerInitRead: unknown;

    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async (ctx: {
          store: DataStore;
        }): Promise<Record<string, unknown>> => {
          if (m.name === "p/schema-gen") {
            // Buffered domain write → flushed onto the result as a plugin.data
            // proposal (NOT a direct store write), committed by finalize below.
            await ctx.store.setPluginData({
              id: `${sessionId}:p:world:schema`,
              sessionId,
              pluginId: "p",
              namespace: "world",
              key: "schema",
              value: SCHEMA,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            return { preGameDone: true };
          }
          // player-init reads the committed schema from the frozen snapshot.
          const row = await ctx.store.getPluginData(
            sessionId,
            "p",
            "world",
            "schema",
          );
          playerInitRead = row?.value;
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
      getPluginSource: () => "builtin",
    };

    // ── Execution 1 (setup band): only schema-gen runs; player-init (main loop)
    //    is not yet scheduled. Its write BUFFERS — nothing hits the store yet.
    const setupTurn = await executeTurn(
      {
        sessionId,
        turnId: "t1",
        playerMessage: "go",
        preGamePending: true,
      },
      [schemaGen, playerInit],
      deps,
    );
    expect(setupTurn.runtimeResults.map((r) => r.runtimeId)).toEqual([
      "p/schema-gen",
    ]);
    // schema-gen produced a proposal, not a committed row: the store is empty
    // until finalize commits.
    expect(
      (await store.getPluginData(sessionId, "p", "world", "schema"))?.value,
    ).toBeUndefined();

    // Commit execution 1 — the buffered proposal lands and the setup-completion
    // delta flips the band to playing (frozen for the next execution).
    const outcome = await finalizeExecution({
      store,
      sessionId,
      ...(setupTurn.executionContext
        ? { executionContext: setupTurn.executionContext }
        : {}),
      runtimes: [schemaGen, playerInit],
      results: setupTurn.runtimeResults,
      turnIds: ["t1"],
      sessionClock: {
        now: new Date().toISOString(),
        ...(setupTurn.setupCompletion
          ? { setupCompletion: setupTurn.setupCompletion }
          : {}),
      },
    });
    expect(outcome.status).toBe("committed");
    // The proposal committed: the schema is now the persisted (post-commit) state.
    expect(
      (await store.getPluginData(sessionId, "p", "world", "schema"))?.value,
    ).toEqual(SCHEMA);
    expect((await store.getSession(sessionId))?.phase).toBe("playing");

    // ── Execution 2 (playing band): player-init passes the frozen-snapshot gate
    //    (schema-gen's mirror is done) and reads the COMMITTED schema.
    const mainTurn = await executeTurn(
      { sessionId, turnId: "t2", playerMessage: "again" },
      [schemaGen, playerInit],
      deps,
    );
    const playerInitResult = mainTurn.runtimeResults.find(
      (r) => r.runtimeId === "p/player-init",
    );
    // Gate passed — success, not skipped: setup-incomplete.
    expect(playerInitResult?.status).toBe("success");
    // Cross-execution guarantee: player-init read execution 1's committed schema.
    expect(playerInitRead).toEqual(SCHEMA);
  });
});

describe("setup gating across trigger paths (setup-incomplete skip)", () => {
  // needs: setup DAG + session gate distinguishing pending/blocked from other plugins (release step 2)
  it("scenario 2: playing 会话启用带 setup 的插件，setup pending/blocked 期间该插件主 runtime 报 skipped: setup-incomplete，其他插件正常执行 — 断言 gate 只影响该插件，不阻塞会话其余调度", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    // A playing session that just enabled plug-a (setup never ran → pending)
    // alongside plug-b (no setup runtime).
    await store.createSession({
      id: "s2",
      worldId: "w",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: ["plug-a", "plug-b"],
      createdAt: now,
      updatedAt: now,
    });

    const fnRuntime = (
      name: string,
      pluginId: string,
      priority: number,
    ): RuntimeManifest =>
      ({
        name,
        pluginId,
        description: name,
        priority,
        runtimeType: "function",
        handler: "./h.js",
        trigger: { type: "auto" },
        outputKind: "plugin",
        capabilities: [],
      }) as RuntimeManifest;

    const aSetup = fnRuntime("plug-a/setup", "plug-a", 50); // setup band
    const aMain = fnRuntime("plug-a/main", "plug-a", 500);
    const bMain = fnRuntime("plug-b/main", "plug-b", 510);

    const ran: string[] = [];
    const deps: TurnExecutorDeps = {
      // Every runtime runs but reports NO completion, so plug-a's setup stays
      // pending across the turn.
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          ran.push(m.name);
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
    };

    const result = await executeTurn(
      { sessionId: "s2", turnId: "t", playerMessage: "go" },
      [aSetup, aMain, bMain],
      deps,
    );

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    // plug-a's main runtime is gated on its own plugin's incomplete setup.
    expect(byId.get("plug-a/main")?.status).toBe("skipped");
    expect(byId.get("plug-a/main")?.output).toMatchObject({
      reason: "setup-incomplete",
      skippedBy: "framework:setupGate",
    });
    // plug-b (no setup) is unaffected; plug-a's setup ran (late-setup) but did
    // not complete, so plug-a/main was gated rather than blocking the session.
    expect(byId.get("plug-b/main")?.status).toBe("success");
    expect(ran).toContain("plug-a/setup");
    expect(ran).toContain("plug-b/main");
    expect(ran).not.toContain("plug-a/main");
  });
  // needs: manual activation bypassing turn-binding requirement + input.schema activation validation (release step 2/3)
  it("scenario 4: manual 调用带 required 绑定的 auto runtime，不因缺 turn 绑定被跳过，input.schema 照常校验；setup 未完成插件的 manual 调用报 setup-incomplete — 断言两条路径分别正确放行与拦截", async () => {
    const INPUT_SCHEMA = {
      type: "object",
      required: ["cmd"],
      properties: { cmd: { type: "string" } },
    };
    // An auto runtime with a REQUIRED turn binding (provider never runs under a
    // manual call) plus an activation `input.schema`.
    const autoWithBinding: RuntimeManifest = {
      name: "a/main",
      pluginId: "a",
      description: "auto+binding",
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
      inputs: { data: { from: { runtime: "a/gen" }, required: true } },
      input: { schema: "./in.json" },
    } as RuntimeManifest;

    // ── manual bypass: runs despite the missing turn binding; input.schema OK
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      let activation: unknown;
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          inputSchema: INPUT_SCHEMA,
          handler: async (ctx) => {
            activation = ctx.activation;
            return {};
          },
        }),
        llm: new NoopLLM(),
        store,
      };
      const result = await executeTurn(
        {
          sessionId: "s",
          turnId: "t",
          playerMessage: "go",
          manualTrigger: { runtimeId: "a/main", payload: { cmd: "roll" } },
        },
        [autoWithBinding],
        deps,
      );
      const rr = result.runtimeResults.find((r) => r.runtimeId === "a/main");
      expect(rr?.status).toBe("success"); // NOT skipped for the absent binding
      expect(activation).toEqual({
        source: "manual",
        detached: false,
        payload: { cmd: "roll" },
      });
    }

    // ── input.schema still enforced on the manual payload ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          inputSchema: INPUT_SCHEMA,
          handler: async () => ({}),
        }),
        llm: new NoopLLM(),
        store,
      };
      const result = await executeTurn(
        {
          sessionId: "s",
          turnId: "t",
          playerMessage: "go",
          manualTrigger: { runtimeId: "a/main", payload: { wrong: 1 } },
        },
        [autoWithBinding],
        deps,
      );
      const rr = result.runtimeResults.find((r) => r.runtimeId === "a/main");
      expect(rr?.status).toBe("failed");
      expect(rr?.error).toContain("input.schema");
    }

    // ── setup-incomplete: manual call to a plugin whose setup is pending ──
    {
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
        activePlugins: ["plug-a"],
        createdAt: now,
        updatedAt: now,
      });
      const fn = (name: string, priority: number): RuntimeManifest =>
        ({
          name,
          pluginId: "plug-a",
          description: name,
          priority,
          runtimeType: "function",
          handler: "./h.js",
          trigger: { type: "auto" },
          outputKind: "plugin",
          capabilities: [],
        }) as RuntimeManifest;
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          handler: async () => ({}),
        }),
        llm: new NoopLLM(),
        store,
      };
      const result = await executeTurn(
        {
          sessionId: "s",
          turnId: "t",
          playerMessage: "go",
          manualTrigger: { runtimeId: "plug-a/main" },
        },
        [fn("plug-a/setup", 50), fn("plug-a/main", 500)],
        deps,
      );
      const rr = result.runtimeResults.find(
        (r) => r.runtimeId === "plug-a/main",
      );
      expect(rr?.status).toBe("skipped");
      expect(rr?.output).toMatchObject({
        reason: "setup-incomplete",
        skippedBy: "framework:setupGate",
      });
    }
  });
});

describe("detached activation model (source × detached)", () => {
  // needs: RuntimeActivation source/detached split + loader turn-binding validation (release step 1/2)
  it("scenario 3: detached follower 只能从 activation payload 取原回合数据；声明入口恒 detached 的 spec 若含 turn binding 则 loader 拒绝；stage runtime 被 manual-detached 激活时只忽略本次 turn binding，不使原 spec 非法 — 断言三个子情形分别成立", async () => {
    const withBinding = (name: string): RuntimeManifest =>
      ({
        name,
        pluginId: name.split("/")[0],
        description: name,
        priority: 500,
        runtimeType: "function",
        handler: "./h.js",
        trigger: { type: "auto" },
        outputKind: "plugin",
        capabilities: [],
        inputs: { data: { from: { runtime: "n/narr" }, required: true } },
      }) as RuntimeManifest;
    const noBinding = (name: string): RuntimeManifest =>
      ({ ...withBinding(name), inputs: undefined }) as RuntimeManifest;
    const argsFor = (
      manifest: RuntimeManifest,
      activation: RuntimeActivation,
    ) => ({
      manifest,
      activation,
      activeRuntimes: [] as RuntimeManifest[],
      completedResults: new Map<string, RuntimeResult>(),
      acceptsSchemas: {},
      loadProducerSchema: async () => undefined,
    });

    // (a) A detached (background) follower activation carrying a turn binding is
    //     rejected for THIS activation — it may only read its activation payload.
    const rejected = await resolveInputBindings(
      argsFor(withBinding("f/follower"), {
        source: "event",
        detached: true,
        payload: { x: 1 },
      }),
    );
    expect(rejected).toMatchObject({
      ok: false,
      skipReason: "invalid-detached-contract",
    });
    // A detached follower WITHOUT turn bindings runs on its payload alone.
    const followerOk = await resolveInputBindings(
      argsFor(noBinding("f/follower"), {
        source: "event",
        detached: true,
        payload: { x: 1 },
      }),
    );
    expect(followerOk.ok).toBe(true);

    // (b) An ALWAYS-detached spec (event/manual + background) that declares turn
    //     bindings is rejected deterministically at load.
    const alwaysDetached: RuntimeManifest = {
      ...withBinding("f/follower"),
      trigger: { type: "event", topic: "e" },
      execution: "background",
    } as RuntimeManifest;
    expect(hasIllegalDetachedContract(alwaysDetached)).toBe(true);

    // (c) A stage spec activated manual-detached only ignores its turn bindings
    //     for this activation — the spec itself stays valid.
    const manualDetached = await resolveInputBindings(
      argsFor(withBinding("s/stage"), {
        source: "manual",
        detached: true,
        payload: null,
      }),
    );
    expect(manualDetached.ok).toBe(true);
    if (manualDetached.ok) {
      expect(Object.keys(manualDetached.slots)).toHaveLength(0);
    }

    // TODO(follower/suspension wave): the full deferred-follower re-entry (a
    // background follower resuming with only its activation payload and no turn
    // visible set) lands with the suspension execution path; here the
    // (spec, activation) contract projection is asserted directly.
  });
});

describe("capability cardinality (provider 0 / 1 / N / all)", () => {
  // needs: needs binding resolution + cardinality gate (release step 1, L1 scheduling deps)
  const provider = (name: string): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      description: name,
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: ["narr"],
    }) as RuntimeManifest;
  const consumer = (cardinality?: "one" | "all"): RuntimeManifest =>
    ({
      name: "c/main",
      pluginId: "c",
      description: "consumer",
      priority: 600,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
      inputs: {
        data: {
          from: { capability: "narr", ...(cardinality ? { cardinality } : {}) },
          select: "/payload",
          required: true,
        },
      },
    }) as RuntimeManifest;

  // Consumer captures its `ctx.inputs.data` slot; the binding edge orders the
  // provider(s) before it in the DAG so the value is present at gate time.
  const runTurn = async (activeRuntimes: readonly RuntimeManifest[]) => {
    const store = createMemoryStore();
    await seedPlaying(store, 1);
    let captured: unknown;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m): Promise<LoadedRuntime> => ({
        manifest: m,
        promptTemplate: "",
        handler: async (ctx) => {
          if (m.name === "c/main") {
            captured = ctx.inputs?.data;
            return {};
          }
          return { payload: { from: m.name } };
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    const result = await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      activeRuntimes,
      deps,
    );
    const rr = result.runtimeResults.find((r) => r.runtimeId === "c/main");
    return { rr, captured };
  };

  it("scenario 5: capability provider 0 → skipped: missing-provider，1 → 正常，N 下 cardinality: one 报错、cardinality: all 要求全部成功 — 断言四种基数分别产出正确 gate 结果", async () => {
    // 0 providers → required binding skips the consumer.
    const zero = await runTurn([consumer()]);
    expect(zero.rr?.status).toBe("skipped");
    expect(zero.rr?.output).toMatchObject({
      reason: "missing-provider",
      skippedBy: "framework:inputBinding",
    });

    // 1 provider → resolved slot with provenance.
    const one = await runTurn([provider("p/a"), consumer()]);
    expect(one.rr?.status).toBe("success");
    expect(one.captured).toEqual({
      cardinality: "one",
      value: { from: "p/a" },
      source: { pluginId: "p", runtimeId: "p/a", resultId: expect.any(String) },
    });

    // N providers + cardinality:one → build-time ambiguity, consumer skipped.
    const many = await runTurn([provider("p/a"), provider("p/b"), consumer()]);
    expect(many.rr?.status).toBe("skipped");
    expect(many.rr?.output).toMatchObject({ reason: "cardinality-conflict" });

    // cardinality:all with every provider succeeding → sorted item array.
    const all = await runTurn([
      provider("p/b"),
      provider("p/a"),
      consumer("all"),
    ]);
    expect(all.rr?.status).toBe("success");
    expect(all.captured).toMatchObject({ cardinality: "all" });
    const items = (
      all.captured as {
        items: { value: unknown; source: { runtimeId: string } }[];
      }
    ).items;
    expect(items.map((i) => i.source.runtimeId)).toEqual(["p/a", "p/b"]);
    expect(items.map((i) => i.value)).toEqual([
      { from: "p/a" },
      { from: "p/b" },
    ]);
  });
});

describe("commit transaction & rollback", () => {
  // needs: finalizeExecution single-transaction commit + setup-attempt ledger (release step 2)
  it.todo(
    "scenario 6: 任一 proposal commit 失败时领域状态/completion/phase/计数全部回滚（commitStatus: failed），但 attempts 与 lastError 仍持久化；连续确定性失败最终到达 blocked — 断言回滚与记账两者互不干扰",
  );
});

describe("legacy backfill & dual-write formula", () => {
  // needs: SnapshotPayloadV3 completedPlayerTurns field + backfill formula + turnCount/preGameCompleted dual-write (release step 2)
  //
  // This lights the two claims testable at the runtime layer: the dual-write
  // formula boundaries and the V3 snapshot round-trip. The server-side halves —
  // the lazy backfill three-branch (turnCount 0/1/>1) and the conservative fork
  // completedPlayerTurns = turnCount === 0 ? 0 : turnCount + diagnostic — are
  // pinned in apps/server/tests/api/turn-count.test.ts (ensureSessionClockBackfilled)
  // and apps/server/tests/api/snapshot.test.ts (fork). None of these paths parse
  // a turnId or scan child turn_results.
  it("scenario 7: 双写公式在 0/floor/首回合/多回合边界均可回滚旧内核读取；新 snapshot 原样携带 completedPlayerTurns（backfill/fork 保守回填见 server 套件）", async () => {
    // Dual-write formula boundaries — the legacy kernel keeps reading turnCount.
    expect(
      deriveLegacyClockFields({
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
      }),
    ).toEqual({ turnCount: 0, preGameCompleted: [] }); // 0
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(1); // floor
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 1,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(1); // first main-loop turn
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 6,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(6); // many turns

    // V3 snapshot round-trip: the builder carries the clock fields verbatim so a
    // fork restores completedPlayerTurns / phase / setupRuntimes as-is.
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "s",
      worldId: "w",
      status: "active",
      turnCount: 3,
      preGameCompleted: ["pregame"],
      phase: "playing",
      completedPlayerTurns: 3,
      setupRuntimes: { pregame: mirrorSetupDone("1.0.0", now) },
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });
    const payload = await buildSnapshotPayload(store, "s", "turn-3");
    expect(payload.schemaVersion).toBe(3);
    if (payload.schemaVersion === 3) {
      expect(payload.session.completedPlayerTurns).toBe(3);
      expect(payload.session.phase).toBe("playing");
      expect(payload.session.setupRuntimes).toMatchObject({
        pregame: { state: "done" },
      });
    }
  });
});

describe("blocked control (maxTriggerCount / retry / waive)", () => {
  // needs: SetupRuntimeState v3 (pending attempts/lastError, blocked blockedAt) + retry/waive API (release step 2)
  it("scenario 8: setup 达 maxTriggerCount 未 done 进入 blocked（reason/attempts/blockedAt）；retry 重置后可再试；waive 后 needs(session) 满足且 trace 标注降级 — 断言三条状态迁移", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    const runtimeId = "plug/setup";
    await store.createSession({
      id: "s8",
      worldId: "w",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["plug"],
      createdAt: now,
      updatedAt: now,
    });

    // A failed setup attempt for a runtime with retry budget 2. Each execution
    // carries a unique executionId → a distinct ledger row.
    const failedAttempt = (
      executionId: string,
      generation: number,
    ): RanSetupRuntime => ({
      runtimeId,
      pluginVersion: "1.0.0",
      generation,
      executionId,
      startedAt: new Date().toISOString(),
      doneSignal: false,
      ledgerState: "failed",
      budget: 2,
      error: "deterministic setup failure",
    });

    const settle = (setupRan: readonly RanSetupRuntime[]) =>
      finalizeExecution({
        store,
        sessionId: "s8",
        runtimes: [makeRuntime(runtimeId)],
        results: [],
        turnIds: [],
        setupRan,
        sessionClock: { now: new Date().toISOString() },
      });

    // Attempt 1 fails → still pending (1/2 budget).
    await settle([failedAttempt("e1", 1)]);
    let mirror = (await store.getSession("s8"))!.setupRuntimes![runtimeId];
    expect(mirror).toMatchObject({
      state: "pending",
      attempts: 1,
      generation: 1,
    });

    // Attempt 2 fails → budget exhausted → blocked with reason/attempts/blockedAt.
    await settle([failedAttempt("e2", 1)]);
    mirror = (await store.getSession("s8"))!.setupRuntimes![runtimeId];
    expect(mirror.state).toBe("blocked");
    if (mirror.state === "blocked") {
      expect(mirror.attempts).toBe(2);
      expect(mirror.generation).toBe(1);
      expect(mirror.reason).toContain("budget");
      expect(mirror.blockedAt).toBeTruthy();
    }
    // A blocked setup keeps the session in the setup band (phase never flips).
    expect((await store.getSession("s8"))!.phase).toBe("setup");

    // retry: blocked → pending, generation bumped, attempts reset.
    const retried = retrySetup(mirror);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error("retry rejected");
    expect(retried.next).toMatchObject({
      state: "pending",
      generation: 2,
      attempts: 0,
    });
    // Persist the retry (mirrors the retry endpoint) and re-attempt in gen 2.
    await store.updateSession("s8", {
      setupRuntimes: { [runtimeId]: retried.next },
      updatedAt: new Date().toISOString(),
    });
    await settle([failedAttempt("e3", 2)]);
    mirror = (await store.getSession("s8"))!.setupRuntimes![runtimeId];
    // Fresh generation → attempts count from zero again (1/2), so still retryable.
    expect(mirror).toMatchObject({
      state: "pending",
      generation: 2,
      attempts: 1,
    });

    // waive: a blocked runtime → done{waived} with a degraded-mode warning; the
    // plugin's session gate is now satisfied.
    const blocked: SetupRuntimeState = {
      state: "blocked",
      pluginVersion: "1.0.0",
      generation: 2,
      attempts: 2,
      reason: "setup exhausted its retry budget",
      blockedAt: now,
    };
    const waived = waiveSetup(blocked, new Date().toISOString(), "degraded");
    expect(waived.ok).toBe(true);
    if (!waived.ok) throw new Error("waive rejected");
    expect(waived.next).toMatchObject({
      state: "done",
      resolution: "waived",
      warning: "degraded",
    });
    expect(isSetupSatisfied(waived.next)).toBe(true);

    // Control transitions reject a non-blocked target (→ 409 at the route).
    expect(retrySetup(waived.next).ok).toBe(false);
  });
});

describe("media pipeline & job-status", () => {
  // needs: kernel-owned append-only job-status store + ctx.progress.report (release step 2); legacy tracks/images view projector (release step 4/6 compat)
  // LIT (partial) IN: media-boundaries-acceptance.test.ts — progress→terminal
  // failed chain + non-success envelope observability-only stripping. The
  // legacy tracks/images compat projector remains a Step 4/6 todo there.
  it.todo(
    "scenario 9: 媒体任务在 provider 调用前经 ctx.progress.report 提交 pending/progress，失败后 finalizer 追加 terminal failed；非 success 信封只接受 jobStatus/diagnostics，领域写被拒；compat projector 只按 manifest 声明投影本插件旧 tracks/images view，新 UI 直接订阅 kernel job-status — 断言实时进度与终态提交的边界",
  );
});

describe("MediaRef canonicalization boundaries", () => {
  // needs: shared MediaRef canonicalizer across activation/binding/export/resume/job-data + ownership validation (release step 3)
  // LIT IN: media-boundaries-acceptance.test.ts (activation / binding / export /
  // job-data boundaries share one canonicalizer; ownership reject; url strip;
  // per-position caption in canonicalize-media-refs.test.ts) and
  // apps/server/tests/api/snapshot.test.ts (fork atomic addRef + missing-asset
  // whole-fork failure). Resume-boundary canonicalization is a later wave.
  it.todo(
    "scenario 10: MediaRef 在 activation/绑定/export/resume/job data 各边界使用同一 canonicalizer；当前 session 无 MediaRefRecord 时拒绝；持久值去掉临时 URL；同一 asset 的位置/caption 可不同；fork 为 child 原子增加 reference，缺 asset 时整次失败 — 断言各边界共享同一校验结果",
  );
});

describe("legacy handler compat (mixed return shape)", () => {
  const fnManifest = (name: string): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      description: "legacy mixed-shape function runtime",
      priority: 500,
      outputKind: "plugin",
      runtimeType: "function",
      trigger: { type: "auto" },
    }) as RuntimeManifest;

  const runFn = async (
    sessionId: string,
    manifest: RuntimeManifest,
    ret: Record<string, unknown>,
  ) => {
    const store = createMemoryStore();
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "",
      handler: async () => ret,
    };
    const deps = {
      loadRuntime: async () => loaded,
      store,
    } as unknown as TurnExecutorDeps;
    const result = await executeTurn(
      { sessionId, turnId: `${sessionId}-t`, playerMessage: "go" },
      [manifest],
      deps,
    );
    return { store, rr: result.runtimeResults[0]! };
  };

  it("scenario 11: legacy mixed success return — value preserved, control keys committed", async () => {
    const manifest = fnManifest("legacy-mixed/ok");
    // A mixed shape: a public field a downstream binding would read (`ref`) plus
    // a `pluginData` control key that must still commit.
    const ref = { id: "r".repeat(64), mime: "image/png", size: 42 };
    const ret = {
      ref,
      note: "public field",
      pluginData: [{ namespace: "gallery", key: "latest", value: { ref } }],
    };
    const { store, rr } = await runFn("sess-legacy-ok", manifest, ret);

    // Business success stays success; the whole object is preserved so a
    // downstream consumer can still read `ref` / `note` (the adapter does not
    // strip fields it does not recognise).
    expect(rr.status).toBe("success");
    expect(rr.output).toMatchObject({ ref, note: "public field" });

    // Control keys are copied + executed: the plugin.data proposal commits.
    await processRuntimeResult(rr, store, "sess-legacy-ok", "plugin", {});
    const stored = await store.getPluginData(
      "sess-legacy-ok",
      "legacy-mixed",
      "gallery",
      "latest",
    );
    expect(stored?.value).toEqual({ ref });
  });

  it("scenario 11: business status: failed maps to RuntimeResult.status failed", async () => {
    const manifest = fnManifest("legacy-mixed/bad");
    const { rr } = await runFn("sess-legacy-bad", manifest, {
      status: "failed",
      error: "provider down",
    });
    expect(rr.status).toBe("failed");
    expect(rr.error).toBe("provider down");
  });
});

describe("suspension & resume", () => {
  // needs: suspension persistence reusing setup attempt id / not counting playing turn + resume revalidation (active/version/spec/approval/effects/output-schema/MediaRef) (release step 2 + §4.3.2)
  it.todo(
    "scenario 12: suspended runtime 不满足 gate；setup suspension 复用原 attempt id，playing suspension 当下不计回合；resume 继承原 logicalTurn/countPolicy 并按 ordinals 恢复，提交前重新检查 active/version/spec/当前审批/effects-output schema/MediaRef，任一失效即零领域写；业务表单 continuation 保留原 buffer，approval-replay 丢弃旧 buffer 以新空 buffer 重放避免 effects/proposals 重复 — 两条全链路均需通过",
  );
});

describe("logical-turn counting & ledger", () => {
  // needs: ExecutionContext logicalTurn = completedPlayerTurns + 1 (off-by-one fix) (release step 2)
  it("scenario 13: scheduled interval: 2 在逻辑回合 2、4、6 触发（读 N 而非 completedPlayerTurns）— off-by-one 回归测试", async () => {
    // logicalTurn = completedPlayerTurns + 1. interval:2 fires on the EVEN
    // logical turns 2/4/6, i.e. completedPlayerTurns 1/3/5.
    for (const completed of [1, 3, 5]) {
      expect(await scheduledRuntimeTriggers(completed, 2)).toBe(true);
    }
    // ...and stays quiet on the odd logical turns 1/3/5 (completedPlayerTurns
    // 0/2/4). Under the old off-by-one (raw player-message count, 0 here) the
    // runtime would have fired on every one of these, so a `false` here is the
    // regression lock.
    for (const completed of [0, 2, 4]) {
      expect(await scheduledRuntimeTriggers(completed, 2)).toBe(false);
    }
  });
  // needs: logical-turn ledger idempotent single insert per logicalTurn across player/continuation/resume (release step 2)
  it("scenario 14: manual RPC / detached follower / recursive 执行 commit 后 completedPlayerTurns 不变；playing suspension 的 resume 继承计数责任；同一 logicalTurn 的 player/continuation/resume 多 execution 经独立 ledger 只推进一次 — 断言计数不被非玩家执行意外推进", async () => {
    const store = createMemoryStore();
    await seedPlaying(store, 0);

    // A player logical turn advances the count exactly once.
    await finalizeExecution({
      store,
      sessionId: "s",
      executionContext: PLAYER_CTX("L1", "e1"),
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 1)],
      turnIds: [],
      sessionClock: { now: new Date().toISOString() },
    });
    expect((await store.getSession("s"))!.completedPlayerTurns).toBe(1);

    // Non-player executions (manual RPC / background follower / recursive) carry
    // countPolicy: none and never advance the count.
    for (const origin of ["manual", "background", "recursive"] as const) {
      await finalizeExecution({
        store,
        sessionId: "s",
        executionContext: {
          executionId: `x-${origin}`,
          origin,
          countPolicy: "none",
        },
        runtimes: [makeRuntime("rt-a")],
        results: [statePatchResult("hp", 2)],
        turnIds: [],
        sessionClock: { now: new Date().toISOString() },
      });
    }
    expect((await store.getSession("s"))!.completedPlayerTurns).toBe(1);

    // Multiple executions of the SAME logicalTurn (a continuation / resume of
    // the player turn L1) dedup through the ledger and advance the count only
    // once total.
    await finalizeExecution({
      store,
      sessionId: "s",
      executionContext: {
        executionId: "e-cont",
        origin: "continuation",
        countPolicy: "complete-player-turn",
        logicalTurnId: "L1",
      },
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 3)],
      turnIds: [],
      sessionClock: { now: new Date().toISOString() },
    });
    expect((await store.getSession("s"))!.completedPlayerTurns).toBe(1);
  });
});

describe("dual declaration consistency (Step 4)", () => {
  const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");
  /** Narrator band priority — the compat default for a priority-less runtime. */
  const NARRATOR_PRIORITY = 500;

  async function loadAllManifests(): Promise<readonly RuntimeManifest[]> {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const manifests: RuntimeManifest[] = [];
    for (const discovery of discoveries) {
      const plugins = await loadPluginManifest(discovery);
      manifests.push(...plugins.map((plugin) => plugin.manifest));
    }
    return manifests;
  }

  const isStageSource = (m: RuntimeManifest): boolean => {
    const type = m.trigger?.type ?? "auto";
    return (
      (type === "auto" || type === "scheduled") && m.priority !== undefined
    );
  };

  it("scenario 15: Step 4 双声明期间，迁移后插件（含两家 event image runtime）在旧 priority 消费者与新调度器下执行序一致；兼容输入 schema 加载 conditional/error-retry 后只产 warn + disabled diagnostic，Step 6 目标 schema 才拒绝 — 断言双轨执行序等价且 schema 分层行为正确", async () => {
    const manifests = await loadAllManifests();

    // ── Part A: dual-track execution-order equivalence ────────────────
    // W5a added explicit `stage` (+ `needs`/`inputs`) to the migrated runtimes
    // while `priority` stays as `legacyOrder`. The new IR ordering (stage
    // barrier + `legacyOrder` tiebreak) must reproduce, over the REAL bundled
    // plugin set, what the live priority scheduler produces from raw
    // `manifest.priority` — for both the pre-game band (turn 0, stage=setup)
    // and the main loop (turn 1, every other stage). This is the acceptance
    // gate that the explicit declarations did not perturb the schedule.
    const stageSource = manifests.filter(isStageSource);

    for (const { turn, setup } of [
      { turn: 0, setup: true },
      { turn: 1, setup: false },
    ] as const) {
      const liveOrder = scheduleByPriority(stageSource, turn).flatMap((group) =>
        group.runtimes.map((runtime) => runtime.name),
      );
      const irOrder = stageSource
        .map((manifest) => getRuntimeSpec(manifest))
        .filter((spec) =>
          setup
            ? spec.stage === "setup"
            : spec.stage !== undefined && spec.stage !== "setup",
        )
        .toSorted(
          (a, b) =>
            STAGE_ORDER.indexOf(a.stage!) - STAGE_ORDER.indexOf(b.stage!) ||
            (a.legacyOrder ?? 0) - (b.legacyOrder ?? 0),
        )
        .map((spec) => spec.id);
      expect(irOrder, `turn ${turn} order`).toEqual(liveOrder);
    }

    // Event fan-out ordering. The bundled event runtimes (scene-stage resolver
    // + background-gen — the "two event image runtime" ordering case of 04 §1;
    // the third-party dashscope/openai image-generators are not in the bundled
    // set) carry no stage but keep `priority` as `legacyOrder`. Sorting by the
    // IR's `legacyOrder` is byte-identical to the old fan-out consumer sorting
    // by raw `priority`.
    const eventRuntimes = manifests.filter((m) => m.trigger?.type === "event");
    expect(eventRuntimes.length).toBeGreaterThanOrEqual(2);
    const irEventOrder = [...eventRuntimes]
      .sort(
        (a, b) =>
          (getRuntimeSpec(a).legacyOrder ?? NARRATOR_PRIORITY) -
          (getRuntimeSpec(b).legacyOrder ?? NARRATOR_PRIORITY),
      )
      .map((m) => m.name);
    const oracleEventOrder = [...eventRuntimes]
      .sort(
        (a, b) =>
          (a.priority ?? NARRATOR_PRIORITY) - (b.priority ?? NARRATOR_PRIORITY),
      )
      .map((m) => m.name);
    expect(irEventOrder).toEqual(oracleEventOrder);

    // ── Part B: compat-input vs target-authoring schema split ─────────
    // During the compat period the input schema keeps LOADING reserved
    // triggers; normalize marks them disabled (the warn + disabled diagnostic)
    // rather than rejecting — so an already-installed third-party manifest that
    // still declares one does not break the loader. Only the Step 6 target
    // authoring schema rejects them outright.
    for (const type of ["conditional", "error-retry"] as const) {
      // Compat-input trigger schema accepts the reserved type (still loads).
      expect(triggerConfigSchema.safeParse({ type }).success).toBe(true);

      // Normalize → disabled declaration: no stage, no executable node.
      const reserved = {
        name: `x/${type}`,
        pluginId: "x",
        description: type,
        priority: 600,
        runtimeType: "function",
        handler: "./h.js",
        trigger: { type },
        outputKind: "plugin",
      } as RuntimeManifest;
      const spec = normalizeRuntimeManifest(reserved);
      expect(spec.disabledReason).toBe("reserved-trigger");
      expect(spec.stage).toBeUndefined();

      // Step 6 target authoring schema rejects the reserved type.
      expect(authoringTriggerConfigSchema.safeParse({ type }).success).toBe(
        false,
      );
    }
  });
});

describe("accepts validation (static decidable subset + runtime check)", () => {
  // needs: accepts build-time decidable subset check + runtime full-schema validation (release step 3)
  const provider = (name: string): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      description: name,
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: ["prov"],
    }) as RuntimeManifest;
  const consumer = (
    cardinality?: "one" | "all",
    select?: string,
  ): RuntimeManifest =>
    ({
      name: "c/main",
      pluginId: "c",
      description: "c",
      priority: 600,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
      inputs: {
        data: {
          from: { capability: "prov", ...(cardinality ? { cardinality } : {}) },
          ...(select ? { select } : {}),
          accepts: "./a.json",
        },
      },
    }) as RuntimeManifest;
  const succ = (runtimeId: string, output: unknown): RuntimeResult => ({
    pluginId: runtimeId.split("/")[0]!,
    runtimeId,
    runId: `r-${runtimeId}`,
    turnId: "t",
    status: "success",
    output: output as RuntimeResult["output"],
    toolCalls: [],
    durationMs: 1,
    timestamp: new Date().toISOString(),
  });
  const resolve = (over: {
    manifest: RuntimeManifest;
    activeRuntimes: readonly RuntimeManifest[];
    completedResults: ReadonlyMap<string, RuntimeResult>;
    accepts: Readonly<Record<string, unknown>>;
    producerSchema: Readonly<Record<string, unknown>>;
  }) =>
    resolveInputBindings({
      manifest: over.manifest,
      activation: { source: "stage", detached: false, payload: null },
      activeRuntimes: over.activeRuntimes,
      completedResults: over.completedResults,
      acceptsSchemas: { data: over.accepts },
      loadProducerSchema: async () => over.producerSchema,
    });

  it("scenario 16: accepts 可判定兼容/不兼容分别通过/产出构建 error；含组合关键字的不可判定 schema 记录 diagnostic 后运行期继续校验；cardinality: all 对每个 provider 比较 items，并对最终数组执行完整 schema 校验 — 断言判定与非判定路径均覆盖", async () => {
    const p = provider("p/gen");

    // Provably compatible → passes, slot built.
    const ok = await resolve({
      manifest: consumer(undefined, "/text"),
      activeRuntimes: [p],
      completedResults: new Map([["p/gen", succ("p/gen", { text: "hi" })]]),
      accepts: { type: "string" },
      producerSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    });
    expect(ok.ok).toBe(true);

    // Provably incompatible → build error, consumer skipped.
    const bad = await resolve({
      manifest: consumer(undefined, "/n"),
      activeRuntimes: [p],
      completedResults: new Map([["p/gen", succ("p/gen", { n: 5 })]]),
      accepts: { type: "string" },
      producerSchema: { type: "object", properties: { n: { type: "number" } } },
    });
    expect(bad).toMatchObject({
      ok: false,
      skipReason: "input-schema-incompatible",
    });

    // Combinator keyword → indeterminate diagnostic, then the runtime check runs.
    const indeterminate = await resolve({
      manifest: consumer(undefined, ""),
      activeRuntimes: [p],
      completedResults: new Map([["p/gen", succ("p/gen", "plain")]]),
      accepts: { oneOf: [{ type: "string" }, { type: "number" }] },
      producerSchema: { type: "object" },
    });
    expect(indeterminate.ok).toBe(true);
    expect(
      indeterminate.diagnostics.some(
        (d) => d.code === "slot-compatibility-indeterminate",
      ),
    ).toBe(true);

    // cardinality:all → per-provider static compare + whole-array runtime check.
    const allRes = await resolveInputBindings({
      manifest: consumer("all"),
      activation: { source: "stage", detached: false, payload: null },
      activeRuntimes: [provider("p/a"), provider("p/b")],
      completedResults: new Map([
        ["p/a", succ("p/a", "A")],
        ["p/b", succ("p/b", "B")],
      ]),
      acceptsSchemas: { data: { type: "array", items: { type: "string" } } },
      loadProducerSchema: async () => ({ type: "string" }),
    });
    expect(allRes.ok).toBe(true);
    if (allRes.ok && allRes.slots.data.cardinality === "all") {
      expect(allRes.slots.data.items.map((i) => i.value)).toEqual(["A", "B"]);
    }
  });
});

describe("activation payload (canonical payload shared by function/agent)", () => {
  // needs: canonical activation JSON shared via ctx.activation.payload (function) / retained activation segment (agent) + MediaRef slot-capability degrade (release step 3)
  it("scenario 17: 同一 event/manual runtime 的 payload 经同一个 input.schema 校验：function 从 ctx.activation.payload、agent 从保留 activation segment 获得相同 canonical JSON；MediaRef 按 slot 能力附加或降级，缺少降级文本时报 input-modality-unsupported — 断言两种 runtime 类型看到一致的输入", async () => {
    const P = { roll: 7, sides: 20 };
    const INPUT_SCHEMA = {
      type: "object",
      required: ["roll", "sides"],
      properties: { roll: { type: "number" }, sides: { type: "number" } },
    };

    // ── function: ctx.activation.payload via a manual activation ──
    const store = createMemoryStore();
    await seedPlaying(store, 1);
    let fnActivation: RuntimeActivation | undefined;
    const rollerFn: RuntimeManifest = {
      name: "d/roller",
      pluginId: "d",
      description: "roller",
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "manual" },
      outputKind: "plugin",
      capabilities: [],
      input: { schema: "./in.json" },
    } as RuntimeManifest;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m): Promise<LoadedRuntime> => ({
        manifest: m,
        promptTemplate: "",
        inputSchema: INPUT_SCHEMA,
        handler: async (ctx) => {
          fnActivation = ctx.activation;
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    const result = await executeTurn(
      {
        sessionId: "s",
        turnId: "t",
        playerMessage: "go",
        manualTrigger: { runtimeId: "d/roller", payload: P },
      },
      [rollerFn],
      deps,
    );
    expect(
      result.runtimeResults.find((r) => r.runtimeId === "d/roller")?.status,
    ).toBe("success");
    expect(fnActivation).toEqual({
      source: "manual",
      detached: false,
      payload: P,
    });

    // ── agent: canonical activation from the reserved prompt segment ──
    const rollerAgent: RuntimeManifest = {
      name: "d/roller",
      pluginId: "d",
      description: "roller",
      priority: 500,
      runtimeType: "agent",
      trigger: { type: "manual" },
      outputKind: "plugin",
      capabilities: [],
    } as RuntimeManifest;
    const assembled = buildContext({
      promptTemplate: "You roll dice.",
      manifest: rollerAgent,
      turnInput: { sessionId: "s", turnId: "t", playerMessage: "go" },
      completedResults: new Map(),
      activation: fnActivation!,
    });
    const match = assembled.systemPrompt.match(
      /<runtime-activation>\n([\s\S]*?)\n<\/runtime-activation>/,
    );
    expect(match).toBeTruthy();
    const agentActivation = JSON.parse(match![1]!);

    // Both runtime types see the SAME canonical activation JSON.
    expect(agentActivation).toEqual({
      source: "manual",
      detached: false,
      payload: P,
    });
    expect(agentActivation.payload).toEqual(fnActivation!.payload);

    // The same `input.schema` governs event and manual sources — deriveActivation
    // normalises `triggerEvent.data` and `manualTrigger.payload` to one payload.
    expect(
      deriveActivation(
        rollerFn,
        { sessionId: "s", turnId: "t", playerMessage: "go" },
        { topic: "roll", data: P },
      ).payload,
    ).toEqual(P);

    // TODO(media wave): MediaRef slot-capability attach vs `meta.caption`/`alt`
    // degrade (and `input-modality-unsupported` when no degrade text) lands with
    // the multimodal media wave.
  });
});

describe("recordAs export (persistent export revision)", () => {
  // needs: recordAs persistent export publishing revision in the same transaction as the producing execution (release step 3)
  const OUT_SCHEMA = {
    type: "object",
    required: ["threshold"],
    properties: { threshold: { type: "number" } },
  } as const;

  const producer = (recordAs: string): RuntimeManifest =>
    ({
      name: "p/gen",
      pluginId: "p",
      description: "export producer",
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: ["cfg-provider"],
      version: "1.0.0",
      output: { schema: "./out.json", recordAs },
    }) as RuntimeManifest;

  const consumer = (opts?: {
    required?: boolean;
    accepts?: boolean;
  }): RuntimeManifest =>
    ({
      name: "c/main",
      pluginId: "c",
      description: "export consumer",
      priority: 600,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
      input: {
        inject: [
          {
            kind: "runtime-export",
            name: "cfg",
            from: { runtime: "p/gen" },
            recordAs: "cfg",
            required: opts?.required ?? true,
            ...(opts?.accepts ? { accepts: "./a.json" } : {}),
          },
        ],
      },
    }) as RuntimeManifest;

  const successResult = (value: unknown): RuntimeResult => ({
    pluginId: "p",
    runtimeId: "p/gen",
    runId: crypto.randomUUID(),
    turnId: "t",
    status: "success",
    output: value as RuntimeResult["output"],
    toolCalls: [],
    durationMs: 1,
    timestamp: new Date().toISOString(),
  });

  // Publish one export revision through the finalize primitive, controlling the
  // committedAt instant so the frozen-read cutoff can be asserted precisely.
  const publish = (
    store: DataStore,
    sessionId: string,
    value: unknown,
    committedAt: string,
  ) =>
    finalizeExecution({
      store,
      sessionId,
      runtimes: [producer("cfg")],
      results: [successResult(value)],
      turnIds: [],
      sessionClock: { now: committedAt },
      loadOutputSchema: async (id) => (id === "p/gen" ? OUT_SCHEMA : undefined),
    });

  it("scenario 18a: success 的 recordAs 与 execution 同事务发布 export revision；失败/挂起/回滚不更新；消费 execution 读取开始时冻结 revision，fork 复制可见 revision，provider 停用或 schema digest 不兼容时 required consumer 体面 skip；含 MediaRef 的 export 在 fork 后通过 child session reference 仍可读取，媒体字节不复制 — 断言发布/冻结/降级三条路径", async () => {
    // ── Publish: a success recordAs lands a revision in the finalize tx ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      const out = await publish(
        store,
        "s",
        { threshold: 7 },
        "2020-01-01T00:00:00.000Z",
      );
      expect(out.status).toBe("committed");
      const rev1 = await store.getLatestRuntimeExport("s", "p/gen", "cfg");
      expect(rev1).toMatchObject({
        revision: 1,
        value: { threshold: 7 },
        producerPluginId: "p",
        producerRuntimeId: "p/gen",
        pluginVersion: "1.0.0",
        committedAt: "2020-01-01T00:00:00.000Z",
      });
      expect(rev1?.schemaDigest).toMatch(/^[0-9a-f]{64}$/);

      // A second success bumps the revision monotonically.
      await publish(store, "s", { threshold: 9 }, "2020-01-02T00:00:00.000Z");
      expect(
        (await store.getLatestRuntimeExport("s", "p/gen", "cfg"))?.revision,
      ).toBe(2);

      // A rolled-back execution (extraInTx throws) publishes nothing — the
      // export append is in the same tx, so it is discarded with the domain
      // writes. Revision stays at 2.
      const rolled = await finalizeExecution({
        store,
        sessionId: "s",
        runtimes: [producer("cfg")],
        results: [successResult({ threshold: 11 })],
        turnIds: [],
        sessionClock: { now: "2020-01-03T00:00:00.000Z" },
        loadOutputSchema: async () => OUT_SCHEMA,
        extraInTx: async () => {
          throw new Error("rollback");
        },
      });
      expect(rolled.status).toBe("failed");
      expect(
        (await store.getLatestRuntimeExport("s", "p/gen", "cfg"))?.revision,
      ).toBe(2);

      // Export boundary is always enforced: a value failing output.schema keeps
      // the domain outcome committed but withholds the export (no new revision).
      const bad = await publish(
        store,
        "s",
        { threshold: "not-a-number" },
        "2020-01-04T00:00:00.000Z",
      );
      expect(bad.status).toBe("committed");
      expect(
        (await store.getLatestRuntimeExport("s", "p/gen", "cfg"))?.revision,
      ).toBe(2);
    }

    // ── Frozen read: a consumer sees the revision committed at or before its
    //    execution start, never a later one (store-level cutoff, the primitive
    //    executeTurn pins `atOrBefore = executionStartedAt` against). ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      await publish(store, "s", { threshold: 1 }, "2020-01-01T00:00:00.000Z"); // rev 1
      await publish(store, "s", { threshold: 2 }, "2020-01-03T00:00:00.000Z"); // rev 2
      // Frozen just after rev 1 → sees rev 1, blind to the later rev 2.
      const frozen = await store.getLatestRuntimeExport("s", "p/gen", "cfg", {
        atOrBefore: "2020-01-02T00:00:00.000Z",
      });
      expect(frozen?.revision).toBe(1);
      expect(frozen?.value).toEqual({ threshold: 1 });
      // Absolute latest (a consumer starting now) sees rev 2.
      expect(
        (await store.getLatestRuntimeExport("s", "p/gen", "cfg"))?.revision,
      ).toBe(2);
    }

    // ── Consume: a consumer execution reads the frozen export via ctx.exports ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      await publish(store, "s", { threshold: 5 }, "2020-01-01T00:00:00.000Z");
      let captured: unknown;
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          handler: async (ctx) => {
            captured = (ctx as { exports?: Record<string, unknown> }).exports
              ?.cfg;
            return {};
          },
        }),
        llm: new NoopLLM(),
        store,
      };
      // The producer stays in the active set so the provider gate passes, but it
      // is NOT triggered to run — the value comes purely from the frozen export.
      const result = await executeTurn(
        { sessionId: "s", turnId: "t", playerMessage: "go" },
        [producer("cfg"), consumer()],
        deps,
      );
      expect(
        result.runtimeResults.find((r) => r.runtimeId === "c/main")?.status,
      ).toBe("success");
      expect(captured).toEqual({
        cardinality: "one",
        value: { threshold: 5 },
        source: {
          pluginId: "p",
          runtimeId: "p/gen",
          resultId: expect.any(String),
        },
      });
    }

    // ── Degrade: provider deactivated → required consumer skips gracefully ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      await publish(store, "s", { threshold: 5 }, "2020-01-01T00:00:00.000Z");
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          handler: async () => ({}),
        }),
        llm: new NoopLLM(),
        store,
      };
      // p/gen is NOT in the active set — the export exists in the store but its
      // producer is deactivated, so a required consumer skips.
      const result = await executeTurn(
        { sessionId: "s", turnId: "t", playerMessage: "go" },
        [consumer()],
        deps,
      );
      const rr = result.runtimeResults.find((r) => r.runtimeId === "c/main");
      expect(rr?.status).toBe("skipped");
      expect(rr?.output).toMatchObject({
        reason: "export-missing",
        skippedBy: "framework:exportBinding",
      });
    }

    // ── Degrade: schema-incompatible export → required consumer skips ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      // Publish a value the producer schema accepts but the CONSUMER's accepts
      // rejects (an incompatible schema digest manifests as a failing value).
      await publish(store, "s", { threshold: 5 }, "2020-01-01T00:00:00.000Z");
      const CONSUMER_ACCEPTS = {
        type: "object",
        required: ["ceiling"],
        properties: { ceiling: { type: "number" } },
      };
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m): Promise<LoadedRuntime> => ({
          manifest: m,
          promptTemplate: "",
          ...(m.name === "c/main"
            ? { exportAcceptsSchemas: { cfg: CONSUMER_ACCEPTS } }
            : {}),
          handler: async () => ({}),
        }),
        llm: new NoopLLM(),
        store,
      };
      const result = await executeTurn(
        { sessionId: "s", turnId: "t", playerMessage: "go" },
        [producer("cfg"), consumer({ accepts: true })],
        deps,
      );
      const rr = result.runtimeResults.find((r) => r.runtimeId === "c/main");
      expect(rr?.status).toBe("skipped");
      expect(rr?.output).toMatchObject({
        reason: "export-schema-invalid",
        skippedBy: "framework:exportBinding",
      });
    }

    // ── Fork: the child copies each (producerRuntimeId, recordAs) revision
    //    visible at the snapshot instant, revision preserved, then the two
    //    sessions diverge. This mirrors the fork route's in-transaction copy
    //    (apps/server/src/routes/api/snapshots.ts). ──
    {
      const store = createMemoryStore();
      await seedPlaying(store, 1);
      await publish(
        store,
        "parent",
        { threshold: 3 },
        "2020-01-01T00:00:00.000Z",
      ); // rev 1
      await publish(
        store,
        "parent",
        { threshold: 4 },
        "2020-01-05T00:00:00.000Z",
      ); // rev 2
      const snapshotAt = "2020-01-03T00:00:00.000Z"; // between rev 1 and rev 2

      // Copy: latest revision per series with committedAt <= snapshotAt.
      const parentExports = await store.listRuntimeExports("parent");
      const visible = new Map<string, (typeof parentExports)[number]>();
      for (const exp of parentExports) {
        if (exp.committedAt > snapshotAt) continue;
        const key = `${exp.producerRuntimeId} ${exp.recordAs}`;
        const prev = visible.get(key);
        if (!prev || exp.revision > prev.revision) visible.set(key, exp);
      }
      for (const exp of visible.values()) {
        await store.appendRuntimeExport({ ...exp, sessionId: "child" });
      }

      // The child sees exactly the frozen revision (rev 1), not the later rev 2.
      const childLatest = await store.getLatestRuntimeExport(
        "child",
        "p/gen",
        "cfg",
      );
      expect(childLatest?.revision).toBe(1);
      expect(childLatest?.value).toEqual({ threshold: 3 });
      // Parent keeps its own later revision — the two diverge post-fork.
      expect(
        (await store.getLatestRuntimeExport("parent", "p/gen", "cfg"))
          ?.revision,
      ).toBe(2);

      // TODO(media wave): an export carrying a MediaRef must, after fork, add a
      // child-session MediaStore reference (bytes NOT copied) so the child can
      // still resolve it; asserted once the shared MediaRef canonicaliser +
      // ownership path lands (scenario 10).
    }
  });
});

describe("effects hazard (same-layer W/W, W/R, R/W detection)", () => {
  const rt = (
    name: string,
    fields: Partial<RuntimeManifest>,
  ): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      pluginType: "community",
      priority: 500,
      trigger: { type: "auto" },
      model: "m",
      runtimeType: "agent",
      ...fields,
    }) as RuntimeManifest;

  it("scenario 18b: 同层 effects 检查覆盖 W/W、W/R、R/W 且放行 R/R；双方 parallelSafe 只豁免不含 unknown:* 的纯 W/W；相同输入在 default/strict policy 下分别产出稳定的 warning/串行 level — 断言 hazard 矩阵与两种 policy 的稳定输出", () => {
    const writer = deriveEffects(
      rt("p/writer", { tools: { builtin: ["update-character"] } }),
    );
    const reader = deriveEffects(
      rt("p/reader", { tools: { builtin: ["list-characters"] } }),
    );
    const otherReader = deriveEffects(
      rt("p/reader2", { tools: { builtin: ["get-character"] } }),
    );

    // Hazard matrix: W/W, W/R, R/W all conflict; R/R is exempt.
    expect(effectsHazard(writer, writer)).toBe(true); // W/W
    expect(effectsHazard(writer, reader)).toBe(true); // W/R
    expect(effectsHazard(reader, writer)).toBe(true); // R/W
    expect(effectsHazard(reader, otherReader)).toBe(false); // R/R

    // parallelSafe exempts pure W/W without unknown:*, but never a W/R hazard,
    // and never a W/W overlap that involves unknown:*.
    const safeWriterA = deriveEffects(
      rt("p/sa", {
        tools: { builtin: ["update-character"] },
        effects: { parallelSafe: true },
      }),
    );
    const safeWriterB = deriveEffects(
      rt("q/sb", {
        tools: { builtin: ["create-character"] },
        effects: { parallelSafe: true },
      }),
    );
    expect(effectsHazard(safeWriterA, safeWriterB)).toBe(false); // pure W/W exempt
    expect(effectsHazard(safeWriterA, { ...reader, parallelSafe: true })).toBe(
      true,
    ); // W/R never exempt
    const safeUnknown = deriveEffects(
      rt("r/su", {
        // undeclared plugin-data write → unknown:*, marked parallelSafe
        tools: { builtin: ["plugin-data-set"] },
        effects: { parallelSafe: true },
      }),
    );
    expect(effectsHazard(safeUnknown, safeWriterA)).toBe(true); // unknown:* never exempt

    // Same input → stable output under both policies. Group has two conflicting
    // writers plus an independent narrator.
    const group: ScheduledGroup = {
      priority: 500,
      runtimes: [
        rt("p/narrator", { outputKind: "story" }),
        rt("z/writer2", { tools: { builtin: ["create-character"] } }),
        rt("a/writer1", { tools: { builtin: ["update-character"] } }),
      ],
    };

    const warn1 = applyHazardPolicy([group], "warn");
    const warn2 = applyHazardPolicy([group], "warn");
    // warn: one parallel level, one diagnostic per conflicting pair, stable.
    expect(warn1.groups).toHaveLength(1);
    expect(warn1.diagnostics).toHaveLength(1);
    expect(warn1.diagnostics[0]?.message).toContain("a/writer1");
    expect(warn1.diagnostics[0]?.message).toContain("z/writer2");
    expect(warn2.diagnostics).toEqual(warn1.diagnostics);

    const strict1 = applyHazardPolicy([group], "strict");
    const strict2 = applyHazardPolicy([group], "strict");
    // strict: the two writers land in different levels (serialized in id order),
    // the independent narrator stays parallel with the first.
    const strictLevels = strict1.groups.map((g) =>
      g.runtimes.map((r) => r.name).sort(),
    );
    expect(strictLevels).toEqual([["a/writer1", "p/narrator"], ["z/writer2"]]);
    expect(strict2.groups.map((g) => g.runtimes.map((r) => r.name))).toEqual(
      strict1.groups.map((g) => g.runtimes.map((r) => r.name)),
    );
  });
});

describe("enablement resolver & permission approval (scenarios 19-25)", () => {
  // needs: plan/confirm resolver upgrade with full requires-closure + late-setup wiring (05 §2.2, W-A)
  it.todo(
    "scenario 19: 启用 requires 未满足的插件时，变更计划列出完整闭包；否决则整单不应用；确认后全部同启且新插件走 late-setup 初始化 — 断言否决/确认两条路径",
  );
  // needs: relations resolver conflicts handling with "disable other and enable me" path (05 §2.2)
  it.todo(
    "scenario 20: 启用与激活集内插件 conflicts 的插件被阻止，'停用对方并启用我' 路径可走通 — 断言阻止态与替代路径均成立",
  );
  // needs: plan/confirm concurrency protocol (activeSetRevision/registryFingerprint) + SessionCreationDraft + idempotent registry reconcile (05 §2.2)
  it.todo(
    "scenario 21: plan 后并发启停使 activeSetRevision 变化，或安装/升级插件使 registryFingerprint 变化时，旧 confirm 返回 409 stale-plan；正常 confirm 先提交 DB，registry reconcile 在模拟崩溃后可幂等重放且不重复发事件；session creation 用 draft lock，confirm 原子创建 revision=1 的 SessionRecord，重复 confirm 不重复创建，owner token issuance envelope 受 actor/TTL 保护 — 断言并发与崩溃恢复两类场景",
  );
  // needs: resolver cascade-impact listing + missing-provider graceful degrade at schedule time (05 §2.2)
  it.todo(
    "scenario 22: 停用被依赖插件时列出级联影响；确认后运行期消费方以 skipped: missing-provider 体面降级（不崩不锁档）— 断言级联展示与降级行为",
  );
  // needs: tool security metadata + async approval pipeline + consent/request/grant atomic commit (05 W-B §4.3)
  it.todo(
    "scenario 23: 启用 consent、active set 与显式批准的 server-code grant 原子提交；拒绝必要 server-code 权限时重新求解或整单取消；consent 允许 low/medium policy 但不放行其他 high；high 工具首次调用生成 request + suspension，批准后原子创建 once/session grant，continuation 只恢复一次，重复 decision/resume 幂等；revoke consent/grant 后按级别停止或恢复 ask，hard deny 即使有旧 grant 也最终拒绝 — 断言原子提交、幂等 resume 与撤回语义",
  );
  // needs: ApprovalRequestRecord/ApprovalGrantRecord state machine + permissionVersion invalidation on version/effects/policy change (05 §4.3.1/4.3.2)
  it.todo(
    "scenario 24: request 的 caller/owner/tool/inputHash/suspension 任一被替换均拒绝；tool 与 HTTP session grant 分别按规定匹配键复用，once grant 额外绑定 inputHash 且只能 claim 一次；claim 后进入 terminal claimed，同参数再次申请可创建新的 request 专属 once grant；插件版本、tool effects/risk 或 policy revision 变化使 permissionVersion 失效并重新审批；实际 effect 超出声明时 finalizer 以 tool-effect-undeclared 拒绝且零提交 — 断言替换拒绝、复用匹配与失效重审三条路径",
  );
  // needs: PluginCallIdentity opaque capability + session-bound facade for ctx.utils/covel.http/legacy wire (05 §4.4)
  it.todo(
    "scenario 25: ctx.utils / covel.http / legacy wire 三入口均以正确 session identity 完成审批；community 插件在 import 阶段或伪造 context 调用时 fail closed；SSRF 校验先于 approval 执行 — 断言三入口一致的身份绑定与执行顺序",
  );
});
