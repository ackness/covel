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

import { describe, it, expect } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  deriveLegacyClockFields,
  isSetupSatisfied,
  mirrorSetupDone,
  retrySetup,
  waiveSetup,
  type ExecutionContext,
  type RanSetupRuntime,
  type RuntimeManifest,
  type SetupRuntimeState,
} from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { buildSnapshotPayload } from "../src/snapshot/snapshot-payload-builder.js";
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
  it.todo(
    "scenario 1: schema-gen 本执行产出 proposal 并 commit，player-init 下一执行经冻结快照 gate 通过并读到已提交 schema — 断言快照读到的是提交后状态，且该保证跨执行成立",
  );
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
  it.todo(
    "scenario 4: manual 调用带 required 绑定的 auto runtime，不因缺 turn 绑定被跳过，input.schema 照常校验；setup 未完成插件的 manual 调用报 setup-incomplete — 断言两条路径分别正确放行与拦截",
  );
});

describe("detached activation model (source × detached)", () => {
  // needs: RuntimeActivation source/detached split + loader turn-binding validation (release step 1/2)
  it.todo(
    "scenario 3: detached follower 只能从 activation payload 取原回合数据；声明入口恒 detached 的 spec 若含 turn binding 则 loader 拒绝；stage runtime 被 manual-detached 激活时只忽略本次 turn binding，不使原 spec 非法 — 断言三个子情形分别成立",
  );
});

describe("capability cardinality (provider 0 / 1 / N / all)", () => {
  // needs: needs binding resolution + cardinality gate (release step 1, L1 scheduling deps)
  it.todo(
    "scenario 5: capability provider 0 → skipped: missing-provider，1 → 正常，N 下 cardinality: one 报错、cardinality: all 要求全部成功 — 断言四种基数分别产出正确 gate 结果",
  );
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
  it.todo(
    "scenario 9: 媒体任务在 provider 调用前经 ctx.progress.report 提交 pending/progress，失败后 finalizer 追加 terminal failed；非 success 信封只接受 jobStatus/diagnostics，领域写被拒；compat projector 只按 manifest 声明投影本插件旧 tracks/images view，新 UI 直接订阅 kernel job-status — 断言实时进度与终态提交的边界",
  );
});

describe("MediaRef canonicalization boundaries", () => {
  // needs: shared MediaRef canonicalizer across activation/binding/export/resume/job-data + ownership validation (release step 3)
  it.todo(
    "scenario 10: MediaRef 在 activation/绑定/export/resume/job data 各边界使用同一 canonicalizer；当前 session 无 MediaRefRecord 时拒绝；持久值去掉临时 URL；同一 asset 的位置/caption 可不同；fork 为 child 原子增加 reference，缺 asset 时整次失败 — 断言各边界共享同一校验结果",
  );
});

describe("legacy handler compat (mixed return shape)", () => {
  // needs: resultFormat: legacy adapter preserving value + copying control keys (release step 3)
  it.todo(
    "scenario 11: legacy handler 混装返回：value 完整保留（ref 等公共字段可被下游绑定读取）、控制键复制执行、业务 failed 映射 status: failed — 断言适配器不剥离下游需要的字段",
  );
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
  // needs: dual declaration (stage/needs coexisting with priority/upstreamRequired) + compat-input vs target-authoring schema split (release step 4, and step 0/6 for the schema split)
  it.todo(
    "scenario 15: Step 4 双声明期间，迁移后插件（含两家 event image runtime）在旧 priority 消费者与新调度器下执行序一致；兼容输入 schema 加载 conditional/error-retry 后只产 warn + disabled diagnostic，Step 6 目标 schema 才拒绝 — 断言双轨执行序等价且 schema 分层行为正确",
  );
});

describe("accepts validation (static decidable subset + runtime check)", () => {
  // needs: accepts build-time decidable subset check + runtime full-schema validation (release step 3)
  it.todo(
    "scenario 16: accepts 可判定兼容/不兼容分别通过/产出构建 error；含组合关键字的不可判定 schema 记录 diagnostic 后运行期继续校验；cardinality: all 对每个 provider 比较 items，并对最终数组执行完整 schema 校验 — 断言判定与非判定路径均覆盖",
  );
});

describe("activation payload (canonical payload shared by function/agent)", () => {
  // needs: canonical activation JSON shared via ctx.activation.payload (function) / retained activation segment (agent) + MediaRef slot-capability degrade (release step 3)
  it.todo(
    "scenario 17: 同一 event/manual runtime 的 payload 经同一个 input.schema 校验：function 从 ctx.activation.payload、agent 从保留 activation segment 获得相同 canonical JSON；MediaRef 按 slot 能力附加或降级，缺少降级文本时报 input-modality-unsupported — 断言两种 runtime 类型看到一致的输入",
  );
});

describe("recordAs export (persistent export revision)", () => {
  // needs: recordAs persistent export publishing revision in the same transaction as the producing execution (release step 3)
  it.todo(
    "scenario 18a: success 的 recordAs 与 execution 同事务发布 export revision；失败/挂起/回滚不更新；消费 execution 读取开始时冻结 revision，fork 复制可见 revision，provider 停用或 schema digest 不兼容时 required consumer 体面 skip；含 MediaRef 的 export 在 fork 后通过 child session reference 仍可读取，媒体字节不复制 — 断言发布/冻结/降级三条路径",
  );
});

describe("effects hazard (same-layer W/W, W/R, R/W detection)", () => {
  // needs: effects read/write hazard derivation from tool whitelists + default/strict concurrency policy (release step 3)
  it.todo(
    "scenario 18b: 同层 effects 检查覆盖 W/W、W/R、R/W 且放行 R/R；双方 parallelSafe 只豁免不含 unknown:* 的纯 W/W；相同输入在 default/strict policy 下分别产出稳定的 warning/串行 level — 断言 hazard 矩阵与两种 policy 的稳定输出",
  );
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
