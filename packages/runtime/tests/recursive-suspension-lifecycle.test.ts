import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createEventBus } from "@covel/events";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  validateBrowserCheckpoint,
  type DataStore,
} from "@covel/store";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
} from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
  createTraceRecorder,
  createHookPipeline,
  settleFailedResumeJobs,
  planSuspensionAbandon,
  applySuspensionAbandonTx,
  settleAbandonedSuspensionJobs,
} from "../src/index.js";
import { readRuntimeTriggerLedger } from "../src/trigger/trigger-ledger.js";

const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});
const backends = [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const;
const now = "2026-10-29T00:00:00.000Z";
const manifest = (name: string, auto = false): RuntimeManifest =>
  ({
    name,
    pluginId: "probe",
    description: name,
    runtimeType: "function",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: auto ? "auto" : "manual" },
  }) as RuntimeManifest;
const parent = manifest("probe/parent", true);
const sibling = manifest("probe/sibling", true);
const child = {
  ...manifest("probe/child", true),
  output: { recordAs: "saved", schema: "./output.json" },
};
const grandchild = manifest("probe/grandchild");
const ok = {
  outcome: "success",
  value: { content: "Saved output" },
  effects: { interactions: [{ interactionId: "answer", type: "form" }] },
} as const;
const ask = {
  outcome: "suspended",
  reason: "Answer",
  resumeSchema: { type: "object" },
} as const;
async function report(ctx: FunctionHandlerContext, jobId: string) {
  await ctx.progress!.report({ jobId, state: "succeeded", sequence: 1 });
  await ctx.pluginData!.set("notes", jobId, jobId);
}

async function fixture(
  create: () => DataStore,
  options: {
    siblings?: boolean;
    reverse?: boolean;
    rollback?: boolean;
    isolate?: boolean;
  } = {},
) {
  const store = create();
  open.push(store);
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const eventBus = createEventBus(store);
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  eventBus.onEmit((event) =>
    events.push({
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  const trace = createTraceRecorder(store, "session", "turn");
  const runs: string[] = [];
  let nestedOwner = "parent";
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers: Record<string, FunctionHandler> = {
    [parent.name]: async (ctx) => {
      if (ctx.resumedFromSuspensionId) return ok;
      if (options.reverse) await barrier;
      await report(ctx, "parent");
      nestedOwner = "parent";
      await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      if (!options.reverse) release();
      return options.isolate ? ok : ask;
    },
    [sibling.name]: async (ctx) => {
      if (ctx.resumedFromSuspensionId) return ok;
      await barrier;
      await report(ctx, "sibling");
      nestedOwner = "sibling";
      await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      return ask;
    },
    [child.name]: async (ctx) => {
      if (ctx.recursionDepth === 0 && !options.reverse) await barrier;
      const key = ctx.recursionDepth ? `${nestedOwner}-child` : "top";
      runs.push(key);
      await report(ctx, key);
      if (ctx.recursionDepth)
        await ctx.recursiveCall({
          manualTrigger: { runtimeId: grandchild.name },
        });
      if (ctx.recursionDepth === 0 && options.reverse) release();
      return options.isolate && ctx.recursionDepth
        ? ask
        : { ...ok, value: { content: key } };
    },
    [grandchild.name]: async (ctx) => {
      const key = `${nestedOwner}-grandchild`;
      runs.push(key);
      await report(ctx, key);
      return ok;
    },
  };
  const story = {
    ...manifest("probe/story", true),
    outputKind: "story" as const,
  };
  handlers[story.name] = async () => ({
    outcome: "success",
    value: { narrativeOutput: "A quiet evening." },
  });
  const runtimes = [
    parent,
    child,
    grandchild,
    ...(options.siblings ? [sibling] : []),
    ...(options.isolate ? [story] : []),
  ];
  const hookPipeline = createHookPipeline();
  const deps = {
    store,
    eventBus,
    hookPipeline,
    llm: { generate: vi.fn() } as never,
    onRuntimeStart: trace.runtimeStarted,
    onRuntimeComplete: async (
      info: Parameters<typeof trace.runtimeCompleted>[0],
    ) => {
      if (info.status === "failed")
        await trace.runtimeFailed({ ...info, error: info.error ?? "failed" });
      else await trace.runtimeCompleted(info);
    },
    loadRuntime: async (runtime: RuntimeManifest) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handlers[runtime.name],
      ...(runtime.name === child.name
        ? {
            outputSchema: {
              type: "object",
              properties: { content: { type: "string" } },
              required: ["content"],
            },
          }
        : {}),
    }),
  };
  const execution = await executeTurn(
    {
      sessionId: "session",
      turnId: "turn",
      logicalTurnId: "logical",
      playerMessage: "Go",
      origin: "player",
    },
    runtimes,
    deps,
  );
  const initial = await commitExecution({
    store,
    eventBus,
    execution,
    ...(options.rollback
      ? {
          extraInTx: async () => {
            throw new Error("transaction rejected");
          },
        }
      : {}),
    ...(options.isolate
      ? {
          proposalGuard: (proposal: import("@covel/shared").Proposal) =>
            (proposal.payload as { key?: string }).key === "parent"
              ? "parent refused"
              : undefined,
        }
      : {}),
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  expect(initial.status).toBe(options.rollback ? "failed" : "committed");
  const suspension = (await store.listSuspensions("session")).find(
    (row) => row.runtimeId === parent.name,
  )!;
  const jobs = async (jobId: string) =>
    (await store.listJobStatus("session", { jobId })).map((row) => row.state);
  const keys = async () =>
    (await store.listPluginData("session", "probe", "notes"))
      .map((row) => row.key)
      .sort();
  const lifecycle = (runId: string) =>
    events
      .filter(
        (event) =>
          event.type.startsWith("runtime.") && event.payload.runId === runId,
      )
      .map((event) => event.payload.status)
      .filter(Boolean);
  const resume = async (saved = suspension) => {
    expect(await store.claimSuspension(saved.id)).not.toBeNull();
    const execution = await resumeSuspendedRuntime(
      saved,
      {},
      runtimes.find((rt) => rt.name === saved.runtimeId)!,
      deps,
      { activeRuntimes: runtimes },
    );
    return execution;
  };
  const commit = (
    execution: Awaited<ReturnType<typeof resume>>,
    saved = suspension,
    rollback = false,
  ) =>
    commitExecution({
      ...(rollback
        ? {
            extraInTx: async () => {
              throw new Error("transaction rejected");
            },
          }
        : {}),
      store,
      eventBus,
      execution: structuredClone(execution),
      completion: {
        kind: "resume",
        turnId: saved.turnId,
        suspensionId: saved.id,
        pluginId: saved.pluginId,
        runtimeId: saved.runtimeId,
      },
    });
  const abandon = async (saved = suspension) => {
    const plan = await planSuspensionAbandon(store, saved);
    await store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, now),
    );
    await settleAbandonedSuspensionJobs({ store, eventBus }, saved);
  };
  return {
    store,
    eventBus,
    events,
    handlers,
    runtimes,
    hookPipeline,
    runs,
    suspension,
    execution,
    jobs,
    keys,
    lifecycle,
    resume,
    commit,
    abandon,
  };
}

describe.each(backends)("saved recursive lifecycle on %s", (_name, create) => {
  it.each([false, true])(
    "keeps independent invocation tasks separate (top first=%s)",
    async (reverse) => {
      const f = await fixture(create, { reverse });
      expect(await f.keys()).toEqual(["top"]);
      expect(await f.jobs("top")).toEqual(["succeeded"]);
      expect(await f.jobs("parent-child")).toEqual([
        "succeeded",
        "waiting-input",
      ]);
      expect(await f.jobs("parent-grandchild")).toEqual([
        "succeeded",
        "waiting-input",
      ]);
    },
  );

  it("persists and broadcasts the original saved identities across checkpoint and commit", async () => {
    const f = await fixture(create);
    const checkpoint = validateBrowserCheckpoint(
      JSON.parse(
        JSON.stringify(
          await exportSessionCheckpoint(f.store, "session", {
            revision: 1,
            actionId: "reload",
          }),
        ),
      ),
    );
    await replaceSessionFromCheckpoint(f.store, checkpoint);
    const saved = checkpoint.suspensions[0]!;
    const members = saved.pendingContinuation.nestedResults!.map(
      (entry) => entry.result as RuntimeResult,
    );
    expect(
      (await f.store.listTurnMessages("session")).filter(
        (row) => row.sourceRuntimeId === child.name,
      ),
    ).toHaveLength(1);
    expect(
      (await readRuntimeTriggerLedger(f.store, "session")).get(grandchild.name),
    ).toBeUndefined();
    for (const member of members)
      expect(f.lifecycle(member.runId)).toEqual(["success", "suspended"]);
    const resumed = await f.resume(saved);
    expect(resumed.commit.results.map((result) => result.runtimeId)).toEqual([
      grandchild.name,
      child.name,
      parent.name,
    ]);
    expect((await f.commit(resumed, saved)).status).toBe("committed");
    expect(f.runs).toHaveLength(3);
    expect(
      (await f.store.getLatestRuntimeExport("session", child.name, "saved"))
        ?.value,
    ).toEqual({ content: "parent-child" });
    expect(
      (await f.store.listTurnMessages("session")).filter(
        (row) => row.sourceRuntimeId === grandchild.name,
      ),
    ).toHaveLength(1);
    expect(await f.keys()).toEqual([
      "parent",
      "parent-child",
      "parent-grandchild",
      "top",
    ]);
    for (const member of members) {
      expect(f.lifecycle(member.runId)).toEqual([
        "success",
        "suspended",
        "success",
      ]);
      const traced = (await f.store.listTraceEvents("session")).filter(
        (row) =>
          (row.payload as { runId?: string }).runId === member.runId &&
          row.type !== "runtime.started",
      );
      expect(
        traced.map((row) => (row.payload as { status: string }).status),
      ).toEqual(["suspended", "success"]);
    }
    expect(
      (await readRuntimeTriggerLedger(f.store, "session")).get(grandchild.name)
        ?.count,
    ).toBe(1);
  });

  it.each(["success", "suspended", "abandon"] as const)(
    "fails a resume and recovers by %s",
    async (next) => {
      const f = await fixture(create);
      f.handlers[parent.name] = async () => ({
        outcome: "failed",
        error: "attempt failed",
      });
      const failed = await f.resume();
      expect(failed.result.status).toBe("failed");
      await settleFailedResumeJobs(
        { store: f.store, eventBus: f.eventBus },
        f.suspension,
      );
      const marker = (await f.store.getSuspension(f.suspension.id))!
        .resolvedAt!;
      await f.store.releaseSuspensionClaim(f.suspension.id, marker);
      for (const job of ["parent", "parent-child", "parent-grandchild"])
        expect((await f.jobs(job)).at(-1)).toBe("failed");
      expect(await f.jobs("top")).toEqual(["succeeded"]);
      if (next === "abandon") await f.abandon();
      else {
        f.handlers[parent.name] = async () => (next === "success" ? ok : ask);
        expect((await f.commit(await f.resume())).status).toBe("committed");
      }
      const target =
        next === "success"
          ? "succeeded"
          : next === "suspended"
            ? "waiting-input"
            : "cancelled";
      for (const job of ["parent", "parent-child", "parent-grandchild"])
        expect((await f.jobs(job)).at(-1)).toBe(target);
      expect(f.runs).toHaveLength(3);
      if (next === "suspended") {
        const newer = (await f.store.listSuspensions("session")).find(
          (row) => !row.resolvedAt,
        )!;
        expect(newer.id).not.toBe(f.suspension.id);
        expect(newer.pendingContinuation.nestedResults).toHaveLength(2);
        f.handlers[parent.name] = async () => ok;
        expect((await f.commit(await f.resume(newer), newer)).status).toBe(
          "committed",
        );
        expect(await f.jobs("parent-grandchild")).toEqual([
          "succeeded",
          "waiting-input",
          "failed",
          "waiting-input",
          "succeeded",
        ]);
        expect(f.runs).toHaveLength(3);
      }
    },
  );

  it.each(["rollback", "isolate"] as const)(
    "leaves no waiting subtree after initial %s",
    async (exit) => {
      const f = await fixture(create, { [exit]: true });
      expect(await f.store.listSuspensions("session")).toEqual([]);
      const held = f.execution.commit.suspensions![0]!;
      for (const entry of held.pendingContinuation.nestedResults!) {
        const result = entry.result as RuntimeResult;
        expect(f.lifecycle(result.runId).at(-1)).toBe("failed");
      }
      expect(f.lifecycle(held.pendingContinuation.lifecycle.runId).at(-1)).toBe(
        "failed",
      );
      expect((await f.jobs("parent-grandchild")).at(-1)).toBe("failed");
      expect(await f.keys()).toEqual(exit === "rollback" ? [] : ["top"]);
      expect(
        (await readRuntimeTriggerLedger(f.store, "session")).get(
          grandchild.name,
        ),
      ).toBeUndefined();
    },
  );

  it.each(["failed", "throw", "timeout", "hook", "rollback"] as const)(
    "settles all saved levels after %s and commits a later retry once",
    async (failure) => {
      const f = await fixture(create);
      const members = f.suspension.pendingContinuation.nestedResults!.map(
        (entry) => entry.result as RuntimeResult,
      );
      if (failure === "failed")
        f.handlers[parent.name] = async () => ({
          outcome: "failed",
          error: "rejected",
        });
      if (failure === "throw")
        f.handlers[parent.name] = async () => {
          throw new Error("private exception");
        };
      if (failure === "timeout") {
        f.runtimes[0] = { ...parent, timeoutMs: 5 };
        f.handlers[parent.name] = () => new Promise(() => {});
      }
      if (failure === "hook")
        f.hookPipeline.register({
          id: "reject-resume",
          event: "PostRuntime",
          handler: async (_ctx, payload) => ({
            action: "continue",
            replace: {
              result: {
                ...(payload as { result: RuntimeResult }).result,
                status: "failed",
                error: "hook rejected",
              },
            },
          }),
        });
      const execution = await f.resume();
      if (failure === "rollback")
        expect((await f.commit(execution, f.suspension, true)).status).toBe(
          "failed",
        );
      else expect(execution.result.status).toBe("failed");
      expect(f.lifecycle(execution.result.runId).at(-1)).toBe("failed");
      const marker = (await f.store.getSuspension(f.suspension.id))!
        .resolvedAt!;
      await settleFailedResumeJobs(
        { store: f.store, eventBus: f.eventBus },
        { ...f.suspension, resolvedAt: marker },
      );
      await settleFailedResumeJobs(
        { store: f.store, eventBus: f.eventBus },
        { ...f.suspension, resolvedAt: marker },
      );
      await f.store.releaseSuspensionClaim(f.suspension.id, marker);
      const checkpoint = validateBrowserCheckpoint(
        JSON.parse(
          JSON.stringify(
            await exportSessionCheckpoint(f.store, "session", {
              revision: 2,
              actionId: "failed-reload",
            }),
          ),
        ),
      );
      await replaceSessionFromCheckpoint(f.store, checkpoint);
      for (const job of ["parent", "parent-child", "parent-grandchild"])
        expect((await f.jobs(job)).at(-1)).toBe("failed");
      for (const member of members)
        expect(f.lifecycle(member.runId)).toEqual([
          "success",
          "suspended",
          "failed",
        ]);
      expect(await f.keys()).toEqual(["top"]);
      f.handlers[parent.name] = async () => ok;
      f.runtimes[0] = parent;
      if (failure === "hook") f.hookPipeline.unregister("reject-resume");
      expect(
        (await f.commit(await f.resume(checkpoint.suspensions[0]!))).status,
      ).toBe("committed");
      for (const member of members)
        expect(f.lifecycle(member.runId)).toEqual([
          "success",
          "suspended",
          "failed",
          "success",
        ]);
      expect(await f.jobs("parent-grandchild")).toEqual([
        "succeeded",
        "waiting-input",
        "failed",
        "succeeded",
      ]);
      expect(f.runs).toHaveLength(3);
    },
  );

  it.each(["success", "abandon"] as const)(
    "settles one subtree by %s without touching another invocation of its child",
    async (next) => {
      const f = await fixture(create, { siblings: true });
      if (next === "abandon") {
        await f.abandon();
        await f.abandon();
      } else {
        expect((await f.commit(await f.resume())).status).toBe("committed");
      }
      expect(await f.jobs("parent-child")).toEqual([
        "succeeded",
        "waiting-input",
        next === "abandon" ? "cancelled" : "succeeded",
      ]);
      expect((await f.jobs("sibling-child")).at(-1)).toBe("waiting-input");
      expect(await f.jobs("top")).toEqual(["succeeded"]);
      expect(await f.keys()).not.toContain("sibling-child");
    },
  );

  it("keeps committed outcomes and other deliveries when one correction transport fails", async () => {
    const f = await fixture(create);
    const delivery = vi.fn().mockRejectedValueOnce(new Error("disconnected"));
    const outcome = await commitExecution({
      store: f.store,
      eventBus: f.eventBus,
      execution: await f.resume(),
      onRuntimeCorrection: delivery,
      completion: {
        kind: "resume",
        turnId: "turn",
        suspensionId: f.suspension.id,
        pluginId: parent.pluginId,
        runtimeId: parent.name,
      },
    });
    expect(outcome).toMatchObject({ status: "committed", fanOutFailed: true });
    expect(delivery).toHaveBeenCalledTimes(3);
    for (const entry of f.suspension.pendingContinuation.nestedResults!)
      expect(f.lifecycle((entry.result as RuntimeResult).runId).at(-1)).toBe(
        "success",
      );
    expect((await f.jobs("parent-child")).at(-1)).toBe("succeeded");
  });
});
