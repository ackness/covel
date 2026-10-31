/**
 * A function that suspends after `ctx.recursiveCall` keeps its children's
 * writes: they are saved with its suspension and commit with its successful
 * resume, children first, as one unit, and they are dropped wherever its own
 * buffered writes would be.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  HandlerResult,
  JsonValue,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
} from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import {
  applySuspensionAbandonTx,
  commitExecution,
  createHookPipeline,
  executeTurn,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
  settleAbandonedSuspensionJobs,
} from "../src/index.js";
import type { HookPipeline } from "../src/hooks/pipeline.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { readRuntimeTriggerLedger } from "../src/trigger/trigger-ledger.js";

const SESSION = "session";
const timestamp = "2026-10-29T00:00:00.000Z";
const input = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player" as const,
};

function manifest(
  id: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `probe/${id}`,
    pluginId: "probe",
    description: id,
    runtimeType: "function",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "manual" },
    ...extra,
  } as RuntimeManifest;
}

const parent = manifest("parent", { trigger: { type: "auto" } });
const child = manifest("child");
const grandchild = manifest("grandchild");
const runtimes = [parent, child];
const storyRuntime = manifest("story", {
  outputKind: "story",
  trigger: { type: "auto" },
});

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

async function note(ctx: FunctionHandlerContext, key: string) {
  await ctx.pluginData!.set("notes", key, key);
}

/** The child writes B and asks a question the player answers through the parent. */
const childHandler: FunctionHandler = async (ctx) => {
  await note(ctx, "B");
  return {
    outcome: "success",
    value: { content: "Pick one" },
    effects: { interactions: [{ interactionId: "pick", type: "form" }] },
  };
};

/** The parent calls the child, writes A and, unless told not to, suspends. */
function parentHandler(suspends: boolean): FunctionHandler {
  return async (ctx) => {
    if (ctx.resumedFromSuspensionId === undefined) {
      await ctx.progress?.report({
        jobId: "parent-job",
        state: "running",
        sequence: 1,
      });
      await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      await note(ctx, "A");
      if (suspends)
        return {
          outcome: "suspended",
          reason: "Need an answer",
          resumeSchema: { type: "object" },
        };
    }
    return ok();
  };
}

/** The child's output schema, for a child that records its output as an export. */
const childSchema = {
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
};

async function fixture(
  options: {
    readonly suspends?: boolean;
    readonly child?: FunctionHandler;
    /** A runtime the child can call, one level below it. */
    readonly grandchild?: FunctionHandler;
    readonly hookPipeline?: HookPipeline;
    /** The child declares `output.recordAs` and loads with an output schema. */
    readonly exportingChild?: boolean;
    /** A story runtime that succeeds beside the parent. */
    readonly story?: boolean;
    /** Commit isolation: the reason to reject a proposal, if any. */
    readonly proposalGuard?: (proposal: {
      readonly payload: unknown;
    }) => string | undefined;
  } = {},
) {
  const childRuntime = options.exportingChild
    ? manifest("child", {
        output: { recordAs: "pick", schema: "./output.json" },
      })
    : child;
  const runtimes = [
    parent,
    childRuntime,
    ...(options.grandchild ? [grandchild] : []),
    ...(options.story ? [storyRuntime] : []),
  ];
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const traces: { type: string; payload: Record<string, unknown> }[] = [];
  const emitter = {
    sessionId: SESSION,
    turnId: input.turnId,
    async emit(type: string, payload: Record<string, unknown>) {
      traces.push({ type, payload });
    },
  } as unknown as TurnEmitter;
  const childRuns = { count: 0 };
  const childBody = options.child ?? childHandler;
  const handlers: Record<string, FunctionHandler> = {
    [parent.name]: parentHandler(options.suspends ?? true),
    [storyRuntime.name]: async () =>
      ok({ narrativeOutput: "The story goes on." }),
    [child.name]: async (ctx) => {
      childRuns.count += 1;
      return childBody(ctx);
    },
    ...(options.grandchild ? { [grandchild.name]: options.grandchild } : {}),
  };
  const deps = {
    store,
    emitter,
    llm: { generate: vi.fn() } as never,
    ...(options.hookPipeline ? { hookPipeline: options.hookPipeline } : {}),
    loadRuntime: async (runtime: RuntimeManifest) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handlers[runtime.name],
      ...(options.exportingChild && runtime.name === child.name
        ? { outputSchema: childSchema }
        : {}),
    }),
  };
  const execution = await executeTurn(input, runtimes, deps);
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    ...(options.proposalGuard
      ? { proposalGuard: options.proposalGuard as never }
      : {}),
  });
  expect(outcome.status).toBe("committed");
  const keys = async () =>
    (await store.listPluginData(SESSION, "probe", "notes"))
      .map((row) => row.key)
      .sort();
  const childRows = async () =>
    (await store.listTurnMessages(SESSION)).filter(
      (row) => row.sourceRuntimeId === child.name,
    );
  const childTriggers = async () =>
    (await readRuntimeTriggerLedger(store, SESSION)).get(child.name)?.count ??
    0;
  const [suspension] = await store.listSuspensions(SESSION);
  return {
    store,
    deps,
    runtimes,
    childRuns,
    traces,
    execution,
    suspension,
    keys,
    childRows,
    childTriggers,
  };
}

function commitResume(
  f: Awaited<ReturnType<typeof fixture>>,
  resumed: Awaited<ReturnType<typeof resumeSuspendedRuntime>>,
) {
  return commitExecution({
    store: f.store,
    execution: structuredClone(resumed),
    completion: {
      kind: "resume",
      turnId: f.suspension!.turnId,
      suspensionId: f.suspension!.id,
      pluginId: f.suspension!.pluginId,
      runtimeId: f.suspension!.runtimeId,
    },
  });
}

describe("nested writes of a suspended parent", () => {
  it("wait with the suspension and commit with its resume, children first", async () => {
    const f = await fixture();
    expect(await f.keys()).toEqual([]);
    const nested = f.suspension!.pendingContinuation.nestedResults ?? [];
    expect(nested).toHaveLength(1);
    expect(nested[0]!.result).toMatchObject({
      runtimeId: child.name,
      status: "success",
      pendingProposals: [
        expect.objectContaining({
          type: "plugin.data",
          payload: expect.objectContaining({ key: "B" }),
        }),
      ],
    });

    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    expect(resumed.result.status).toBe("success");
    expect(resumed.commit.results.map((result) => result.runtimeId)).toEqual([
      child.name,
      parent.name,
    ]);
    expect(resumed.commit.commitUnits).toEqual([2]);
    expect((await commitResume(f, resumed)).status).toBe("committed");
    expect(await f.keys()).toEqual(["A", "B"]);

    // The child's conversation row and trigger count are what the same
    // parent leaves when it succeeds without suspending.
    const direct = await fixture({ suspends: false });
    expect(await direct.keys()).toEqual(["A", "B"]);
    expect((await direct.childRows()).length).toBe(1);
    expect((await f.childRows()).length).toBe(
      (await direct.childRows()).length,
    );
    expect((await f.childRows())[0]).toMatchObject({
      pendingInput: [expect.objectContaining({ interactionId: "pick" })],
    });
    expect(await direct.childTriggers()).toBe(1);
    expect(await f.childTriggers()).toBe(await direct.childTriggers());
  });

  it("publish a restored child's export with its resume, without running the child again", async () => {
    const f = await fixture({ exportingChild: true });
    expect(f.childRuns.count).toBe(1);
    expect(
      await f.store.getLatestRuntimeExport(SESSION, child.name, "pick"),
    ).toBeNull();

    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: f.runtimes },
    );
    expect(resumed.result.status).toBe("success");
    expect(resumed.commit.outputSchemas[child.name]).toEqual(childSchema);
    expect((await commitResume(f, resumed)).status).toBe("committed");
    expect(f.childRuns.count).toBe(1);
    expect(await f.keys()).toEqual(["A", "B"]);
    expect(
      (await f.store.getLatestRuntimeExport(SESSION, child.name, "pick"))
        ?.value,
    ).toMatchObject({ content: "Pick one" });
  });

  it("voids the resume when a nested write's target changed after the suspension", async () => {
    const f = await fixture();
    await f.store.setPluginData({
      id: "manual-write",
      sessionId: SESSION,
      pluginId: "probe",
      namespace: "notes",
      key: "B",
      value: "written by a manual run",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    const outcome = await commitResume(f, resumed);
    expect(outcome.code).toBe("suspension-data-changed");
    expect(await f.keys()).toEqual(["B"]);
    expect(
      (await f.store.getPluginData(SESSION, "probe", "notes", "B"))?.value,
    ).toBe("written by a manual run");
  });

  it("are dropped when PostRuntime turns the resumed parent's success into failure", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "fail-resumed-parent",
      event: "PostRuntime",
      handler: async (_context, payload) => {
        const { result, resumed } = payload as {
          result: RuntimeResult;
          resumed?: boolean;
        };
        if (!resumed || result.runtimeId !== parent.name)
          return { action: "continue" };
        return {
          action: "continue",
          replace: {
            result: { ...result, status: "failed", error: "vetoed" },
          },
        };
      },
    });
    const f = await fixture({ hookPipeline });
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    expect(resumed.result.status).toBe("failed");
    expect(resumed.commit.results.map((result) => result.runtimeId)).toEqual([
      parent.name,
    ]);
    expect(resumed.commit.results[0]?.pendingProposals).toBeUndefined();
    expect(await f.keys()).toEqual([]);
  });

  it("are dropped when the suspension is abandoned", async () => {
    const f = await fixture();
    const plan = await planSuspensionAbandon(f.store, f.suspension!);
    await f.store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, timestamp),
    );
    expect(await f.keys()).toEqual([]);
    expect(
      (await f.store.listSuspensions(SESSION)).filter(
        (record) => record.resolvedAt === undefined,
      ),
    ).toEqual([]);
  });

  it("leave out a nested run that itself suspended, and trace it", async () => {
    const f = await fixture({
      child: async (ctx) => {
        await note(ctx, "B");
        return {
          outcome: "suspended",
          reason: "The child asks too",
          resumeSchema: { type: "object" },
        };
      },
    });
    expect(await f.store.listSuspensions(SESSION)).toHaveLength(1);
    expect(f.suspension!.runtimeId).toBe(parent.name);
    expect(f.suspension!.pendingContinuation.nestedResults).toBeUndefined();
    expect(
      f.traces.filter(
        (trace) => trace.payload.code === "nested-suspension-dropped",
      ),
    ).toEqual([
      {
        type: "recursive.failed",
        payload: expect.objectContaining({
          runtimeId: parent.name,
          nestedRuntimeId: child.name,
        }),
      },
    ]);
  });
});

/** A child that reports `child-job` (running, then as told) before it writes. */
function reportingChild(final?: "succeeded"): FunctionHandler {
  return async (ctx) => {
    await ctx.progress?.report({
      jobId: "child-job",
      state: "running",
      sequence: 1,
    });
    if (final)
      await ctx.progress?.report({
        jobId: "child-job",
        state: final,
        sequence: 2,
      });
    return childHandler(ctx);
  };
}

/** The child reports a task, asks, and finishes when it is answered. */
const askingChild: FunctionHandler = async (ctx) => {
  if (ctx.resumedFromSuspensionId !== undefined) return ok();
  await ctx.progress?.report({
    jobId: "child-job",
    state: "running",
    sequence: 1,
  });
  return {
    outcome: "suspended",
    reason: "The child asks",
    resumeSchema: { type: "object" },
  };
};

describe("progress of a suspended parent's nested calls", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const scopeOf = (f: Fixture) =>
    f.suspension!.pendingContinuation.executionContext.executionId;

  const states = async (f: Fixture, jobId: string) =>
    (
      await f.store.listJobStatus(SESSION, {
        progressScopeId: scopeOf(f),
        jobId,
      })
    ).map((record) => record.state);

  const resumeAndCommit = async (f: Fixture) => {
    expect(await f.store.claimSuspension(f.suspension!.id)).not.toBeNull();
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: f.runtimes },
    );
    return { resumed, outcome: await commitResume(f, resumed) };
  };

  it("are recorded under the suspended execution's scope with the child's own runtime", async () => {
    const f = await fixture({ child: reportingChild() });
    const rows = await f.store.listJobStatus(SESSION, {
      progressScopeId: scopeOf(f),
      jobId: "child-job",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.runtimeId === child.name)).toBe(true);
    expect(rows.every((row) => row.pluginId === "probe")).toBe(true);
  });

  it("wait for input with the parent's own tasks", async () => {
    const f = await fixture({ child: reportingChild() });
    expect(await states(f, "parent-job")).toEqual(["running", "waiting-input"]);
    expect(await states(f, "child-job")).toEqual(["running", "waiting-input"]);
  });

  it("take back a child's claimed success", async () => {
    const f = await fixture({ child: reportingChild("succeeded") });
    expect(await states(f, "child-job")).toEqual([
      "running",
      "succeeded",
      "waiting-input",
    ]);
  });

  it("end with the resume's commit, once, with the result they were saved with", async () => {
    const f = await fixture({ child: reportingChild() });
    const { outcome } = await resumeAndCommit(f);
    expect(outcome.status).toBe("committed");
    expect(await states(f, "child-job")).toEqual([
      "running",
      "waiting-input",
      "succeeded",
    ]);
    expect(await states(f, "parent-job")).toEqual([
      "running",
      "waiting-input",
      "succeeded",
    ]);
  });

  it("are cancelled with the parent when the suspension is abandoned, and only once", async () => {
    const f = await fixture({ child: reportingChild() });
    const plan = await planSuspensionAbandon(f.store, f.suspension!);
    await f.store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, timestamp),
    );
    await settleAbandonedSuspensionJobs({ store: f.store }, f.suspension!);
    const cancelled = ["running", "waiting-input", "cancelled"];
    expect(await states(f, "child-job")).toEqual(cancelled);
    expect(await states(f, "parent-job")).toEqual(cancelled);

    await settleAbandonedSuspensionJobs({ store: f.store }, f.suspension!);
    expect(await states(f, "child-job")).toEqual(cancelled);
    expect(await states(f, "parent-job")).toEqual(cancelled);
  });

  it("leave a task that already ended alone when the suspension is abandoned", async () => {
    const f = await fixture({ child: reportingChild() });
    await f.store.appendJobStatus({
      sessionId: SESSION,
      progressScopeId: scopeOf(f),
      pluginId: "probe",
      runtimeId: child.name,
      jobId: "child-job",
      sequence: 99,
      state: "failed",
      createdAt: timestamp,
    } as never);
    await settleAbandonedSuspensionJobs({ store: f.store }, f.suspension!);
    expect((await states(f, "child-job")).at(-1)).toBe("failed");
  });

  it("stay waiting for input when a resume fails and the suspension stays open", async () => {
    const f = await fixture({ child: reportingChild() });
    expect(await f.store.claimSuspension(f.suspension!.id)).not.toBeNull();
    const failing = {
      ...f.deps,
      loadRuntime: async (runtime: RuntimeManifest) => ({
        manifest: runtime,
        promptTemplate: "",
        handler: (async (ctx) => {
          if (ctx.resumedFromSuspensionId !== undefined)
            return { outcome: "failed", error: "still broken" };
          return ok();
        }) as FunctionHandler,
      }),
    };
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      failing,
      { activeRuntimes: f.runtimes },
    );
    expect(resumed.result.status).toBe("failed");
    expect(await states(f, "child-job")).toEqual(["running", "waiting-input"]);
  });

  it("end failed, and the child's suspension is never saved, when the parent's unit is dropped at commit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture({
      suspends: false,
      child: askingChild,
      story: true,
      proposalGuard: (proposal) =>
        (proposal.payload as { key?: unknown }).key === "A"
          ? "parent rejected"
          : undefined,
    });
    // The child did ask, the story committed, and the parent's unit did not.
    expect(f.childRuns.count).toBe(1);
    expect(f.execution.commit.suspensions).toHaveLength(1);
    expect(f.suspension).toBeUndefined();
    expect(await f.store.listSuspensions(SESSION)).toEqual([]);
    expect(await f.keys()).toEqual([]);
    const reported = await f.store.listJobStatus(SESSION, {
      progressScopeId: f.execution.commit.executionContext.executionId,
      jobId: "child-job",
    });
    expect(reported.map((record) => record.state)).toEqual([
      "running",
      "failed",
    ]);
  });

  it("end failed, and the suspension holding them is never saved, when the unit around it is dropped at commit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The outer handler succeeds but its write is rejected; the child it
    // called suspends after a call of its own, whose saved result waits in
    // that suspension.
    const f = await fixture({
      suspends: false,
      story: true,
      grandchild: async (ctx) => {
        await ctx.progress?.report({
          jobId: "grandchild-job",
          state: "running",
          sequence: 1,
        });
        return ok();
      },
      child: async (ctx) => {
        if (ctx.resumedFromSuspensionId !== undefined) return ok();
        await ctx.recursiveCall({
          manualTrigger: { runtimeId: grandchild.name },
        });
        return {
          outcome: "suspended",
          reason: "The child asks",
          resumeSchema: { type: "object" },
        };
      },
      proposalGuard: (proposal) =>
        (proposal.payload as { key?: unknown }).key === "A"
          ? "outer rejected"
          : undefined,
    });
    const held = f.execution.commit.suspensions?.[0];
    expect(held?.pendingContinuation.nestedResults).toHaveLength(1);
    expect(f.suspension).toBeUndefined();
    expect(await f.store.listSuspensions(SESSION)).toEqual([]);
    const reported = await f.store.listJobStatus(SESSION, {
      progressScopeId: f.execution.commit.executionContext.executionId,
      jobId: "grandchild-job",
    });
    expect(reported.map((record) => record.state)).toEqual([
      "running",
      "failed",
    ]);
  });

  describe("when the child itself suspends and the parent succeeds", () => {
    async function asked() {
      const f = await fixture({ suspends: false, child: askingChild });
      const saved = f.suspension!;
      expect(saved.runtimeId).toBe(child.name);
      const scope = f.execution.commit.executionContext.executionId;
      // Its own execution identity is not the scope its task reports under.
      expect(saved.pendingContinuation.executionContext.executionId).not.toBe(
        scope,
      );
      const childStates = async () =>
        (
          await f.store.listJobStatus(SESSION, {
            progressScopeId: scope,
            jobId: "child-job",
          })
        ).map((record) => record.state);
      expect(await childStates()).toEqual(["running", "waiting-input"]);
      return { f, saved, childStates };
    }

    it("settles the child's task with its resume", async () => {
      const { f, saved, childStates } = await asked();
      expect(await f.store.claimSuspension(saved.id)).not.toBeNull();
      const resumed = await resumeSuspendedRuntime(saved, {}, child, f.deps, {
        activeRuntimes: f.runtimes,
      });
      expect(resumed.result.status).toBe("success");
      const outcome = await commitExecution({
        store: f.store,
        execution: structuredClone(resumed),
        completion: {
          kind: "resume",
          turnId: saved.turnId,
          suspensionId: saved.id,
          pluginId: saved.pluginId,
          runtimeId: saved.runtimeId,
        },
      });
      expect(outcome.status).toBe("committed");
      expect(await childStates()).toEqual([
        "running",
        "waiting-input",
        "succeeded",
      ]);
    });

    it("cancels the child's task when the suspension is abandoned", async () => {
      const { f, saved, childStates } = await asked();
      const plan = await planSuspensionAbandon(f.store, saved);
      await f.store.withTransaction((tx) =>
        applySuspensionAbandonTx(tx, plan, timestamp),
      );
      await settleAbandonedSuspensionJobs({ store: f.store }, saved);
      expect(await childStates()).toEqual([
        "running",
        "waiting-input",
        "cancelled",
      ]);
    });
  });
});
