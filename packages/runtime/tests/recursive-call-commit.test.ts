/**
 * How `ctx.recursiveCall` results reach the commit.
 *
 * A nested execution's results commit only with a parent handler that
 * succeeded on its own, the same rule as the write buffer; the parent receives
 * a copy while the kernel commits its originals; and each parent's nested
 * results settle right before it, so commit-time dependency checks see a
 * child's outcome before anything that depends on it.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  JsonValue,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
  finalizeExecution,
  resumeSuspendedRuntime,
  suspensionOutdatedReason,
} from "../src/index.js";
import type { HookPipeline } from "../src/hooks/pipeline.js";
import { readRuntimeTriggerLedger } from "../src/trigger/trigger-ledger.js";

const SESSION = "session";
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

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

async function call(ctx: FunctionHandlerContext, id: string) {
  return ctx.recursiveCall({ manualTrigger: { runtimeId: `probe/${id}` } });
}

async function note(ctx: FunctionHandlerContext, key: string, value = key) {
  await ctx.pluginData!.set("notes", key, value);
}

async function run(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  options: {
    readonly hookPipeline?: HookPipeline;
    readonly guards?: Record<string, LoadedRuntime["guard"]>;
    readonly proposalGuard?: (proposal: Proposal) => string | undefined;
    readonly llm?: { readonly generate: (...args: never[]) => unknown };
    readonly setupRuntimes?: Record<string, SetupRuntimeState>;
  } = {},
) {
  const store = createMemoryStore();
  const timestamp = "2026-10-29T00:00:00.000Z";
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: options.setupRuntimes ?? {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const execution = await executeTurn(input, runtimes, {
    store,
    llm: (options.llm ?? { generate: vi.fn() }) as never,
    ...(options.hookPipeline ? { hookPipeline: options.hookPipeline } : {}),
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "",
      ...(options.guards?.[runtime.name]
        ? { guard: options.guards[runtime.name] }
        : {}),
      handler: handlers[runtime.name],
    }),
  });
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    ...(options.proposalGuard ? { proposalGuard: options.proposalGuard } : {}),
  });
  const notes = Object.fromEntries(
    (await store.listPluginData(SESSION, "probe", "notes")).map((row) => [
      row.key,
      row.value,
    ]),
  );
  return { store, execution, outcome, notes };
}

const ids = (results: readonly { readonly runtimeId: string }[]) =>
  results.map((result) => result.runtimeId);

describe("recursiveCall results at commit", () => {
  it.each(["throws", "returns failed"] as const)(
    "drops the child's writes when the parent %s after the call returns",
    async (failure) => {
      const parent = manifest("parent", { trigger: { type: "auto" } });
      const child = manifest("child");
      let childStatus: string | undefined;
      const { execution, outcome, notes } = await run([parent, child], {
        [parent.name]: async (ctx) => {
          const nested = await call(ctx, "child");
          childStatus = nested.runtimeResults[0]?.status;
          await note(ctx, "parent");
          if (failure === "throws") throw new Error("parent broke");
          return { outcome: "failed", error: "parent gave up" };
        },
        [child.name]: async (ctx) => {
          await note(ctx, "child");
          return ok();
        },
      });

      expect(childStatus).toBe("success");
      expect(ids(execution.commit.results)).toEqual([parent.name]);
      expect(execution.commit.results[0]?.status).toBe("failed");
      expect(execution.result.nestedRuntimeResults).toBeUndefined();
      expect(outcome.status).toBe("committed");
      expect(notes).toEqual({});
    },
  );

  it("drops the child's writes when a PostRuntime hook turns the parent's failure into success", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const child = manifest("child");
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "recover-parent",
      event: "PostRuntime",
      handler: async (_context: unknown, payload: unknown) => {
        const { result } = payload as { result: RuntimeResult };
        if (result.runtimeId !== parent.name || result.status !== "failed")
          return { action: "continue" as const };
        return {
          action: "continue" as const,
          replace: {
            result: { ...result, status: "success", output: { ok: true } },
          },
        };
      },
    });
    const { execution, notes } = await run(
      [parent, child],
      {
        [parent.name]: async (ctx) => {
          await call(ctx, "child");
          await note(ctx, "parent");
          return { outcome: "failed", error: "parent gave up" };
        },
        [child.name]: async (ctx) => {
          await note(ctx, "child");
          return ok();
        },
      },
      { hookPipeline },
    );

    expect(execution.commit.results).toEqual([
      expect.objectContaining({ runtimeId: parent.name, status: "success" }),
    ]);
    expect(notes).toEqual({});
  });

  it("drops a grandchild with the child that failed, and keeps both with a successful chain", async () => {
    const top = manifest("top", { trigger: { type: "auto" } });
    const middle = manifest("middle");
    const leaf = manifest("leaf");
    const handlers = (
      middleFails: boolean,
    ): Record<string, FunctionHandler> => ({
      [top.name]: async (ctx) => {
        await call(ctx, "middle");
        await note(ctx, "top");
        return ok();
      },
      [middle.name]: async (ctx) => {
        await call(ctx, "leaf");
        await note(ctx, "middle");
        if (middleFails) throw new Error("middle broke");
        return ok();
      },
      [leaf.name]: async (ctx) => {
        await note(ctx, "leaf");
        return ok();
      },
    });

    const failed = await run([top, middle, leaf], handlers(true));
    expect(ids(failed.execution.commit.results)).toEqual([
      middle.name,
      top.name,
    ]);
    expect(failed.notes).toEqual({ top: "top" });

    const succeeded = await run([top, middle, leaf], handlers(false));
    expect(ids(succeeded.execution.commit.results)).toEqual([
      leaf.name,
      middle.name,
      top.name,
    ]);
    expect(ids(succeeded.execution.result.nestedRuntimeResults ?? [])).toEqual([
      leaf.name,
      middle.name,
    ]);
    expect(succeeded.notes).toEqual({
      top: "top",
      middle: "middle",
      leaf: "leaf",
    });
  });

  it("commits the kernel's originals whatever the parent does to the returned copy", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const child = manifest("child");
    let copyHadWrites = false;
    const { execution, outcome, notes, store } = await run([parent, child], {
      [parent.name]: async (ctx) => {
        const nested = await call(ctx, "child");
        const result = nested.runtimeResults[0] as {
          -readonly [K in keyof RuntimeResult]: RuntimeResult[K];
        };
        const writes = result.pendingProposals as Proposal[];
        copyHadWrites = writes.length === 1;
        result.pluginId = "victim";
        result.runtimeId = "victim/runtime";
        (writes[0]!.payload as { value: unknown }).value = "forged";
        writes.push({
          ...writes[0]!,
          id: "forged-write",
          payload: { namespace: "notes", key: "extra", value: "forged" },
        } as Proposal);
        await note(ctx, "parent");
        return ok();
      },
      [child.name]: async (ctx) => {
        await note(ctx, "child");
        return ok({ answer: 42 });
      },
    });

    expect(copyHadWrites).toBe(true);
    expect(outcome.status).toBe("committed");
    expect(execution.commit.results).toEqual([
      expect.objectContaining({ pluginId: "probe", runtimeId: child.name }),
      expect.objectContaining({ pluginId: "probe", runtimeId: parent.name }),
    ]);
    expect(execution.commit.results[0]?.pendingProposals).toHaveLength(1);
    expect(notes).toEqual({ child: "child", parent: "parent" });
    expect(await store.listPluginData(SESSION, "victim", "notes")).toEqual([]);
  });

  describe("a top-level runtime and its nested calls commit as one unit", () => {
    // `a` calls `b`, which calls `c`. `f` follows `probe.t`, which `a` and its
    // grandchild `c` both emit, so `f` runs twice: once inside `c`'s nested
    // execution and once at top level. Each run writes its own key.
    const story = manifest("story", {
      outputKind: "story",
      trigger: { type: "auto" },
    });
    const a = manifest("a", { stage: "post-turn", trigger: { type: "auto" } });
    const b = manifest("b");
    const c = manifest("c");
    const f = manifest("f", {
      stage: "post-turn",
      trigger: { type: "event", topic: "probe.t" },
    });
    const emitT = { events: [{ topic: "probe.t", data: {} }] };

    async function nestedFollower(rejected: readonly string[]) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const ran = await run(
        [story, a, b, c, f],
        {
          [story.name]: async () =>
            ok({ narrativeOutput: "The story goes on." }),
          [a.name]: async (ctx) => {
            await call(ctx, "b");
            await note(ctx, "a");
            return { outcome: "success", value: {}, effects: emitT };
          },
          [b.name]: async (ctx) => {
            await call(ctx, "c");
            await note(ctx, "b");
            return ok();
          },
          [c.name]: async (ctx) => {
            await note(ctx, "c");
            return { outcome: "success", value: {}, effects: emitT };
          },
          [f.name]: async (ctx) => {
            await note(ctx, ctx.recursionDepth === 0 ? "f" : "f-nested");
            return ok();
          },
        },
        {
          proposalGuard: (proposal) => {
            const key = (proposal.payload as { key?: unknown }).key;
            return typeof key === "string" && rejected.includes(key)
              ? `${key} rejected`
              : undefined;
          },
        },
      );
      // Commit order: story, c, nested f, b, a, top-level f.
      const [, , nestedF, , , topF] = ran.execution.commit.results;
      const persisted = (await ran.store.listTurnResults(SESSION)).flatMap(
        (row) => row.runtimeResults as RuntimeResult[],
      );
      const persistedStatus = (
        result: { readonly runId: string } | undefined,
      ) => persisted.find((entry) => entry.runId === result?.runId)?.status;
      return {
        ...ran,
        nestedF: persistedStatus(nestedF),
        topF: persistedStatus(topF),
        runs: { nestedF: nestedF!.runId, topF: topF!.runId },
      };
    }

    it("orders every unit child-first and drops the whole unit with any rejected member", async () => {
      const { execution, outcome, notes, runs, nestedF, topF } =
        await nestedFollower(["c"]);

      expect(ids(execution.commit.results)).toEqual([
        story.name,
        c.name,
        f.name,
        b.name,
        a.name,
        f.name,
      ]);
      expect(outcome.status).toBe("committed");
      // `c`'s rejection takes `a`, `b` and the nested `f` with it. Without
      // `a`'s event, the top-level `f` has no emitter left and drops too.
      expect(outcome.isolatedRuntimes).toEqual([
        {
          runtimeId: c.name,
          runId: expect.any(String),
          cause: "nested",
          error: expect.any(String),
        },
        {
          runtimeId: f.name,
          runId: runs.nestedF,
          cause: "nested",
          error: expect.any(String),
        },
        {
          runtimeId: b.name,
          runId: expect.any(String),
          cause: "nested",
          error: expect.any(String),
        },
        {
          runtimeId: a.name,
          runId: expect.any(String),
          cause: "rejected",
          error: "c rejected",
        },
        {
          runtimeId: f.name,
          runId: runs.topF,
          cause: "upstream",
          error: "upstream probe/a did not commit",
        },
      ]);
      expect(notes).toEqual({});
      expect([nestedF, topF]).toEqual(["failed", "failed"]);
    });

    it("rolls a nested follower's writes back with its unit", async () => {
      const { outcome, notes, nestedF, topF } = await nestedFollower([
        "f-nested",
      ]);

      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
        c.name,
        f.name,
        b.name,
        a.name,
        f.name,
      ]);
      expect(notes).toEqual({});
      expect([nestedF, topF]).toEqual(["failed", "failed"]);
    });

    it("drops only the top-level follower when its own write is rejected", async () => {
      const { outcome, notes, runs, nestedF, topF } = await nestedFollower([
        "f",
      ]);

      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toEqual([
        {
          runtimeId: f.name,
          runId: runs.topF,
          cause: "rejected",
          error: "f rejected",
        },
      ]);
      expect(notes).toEqual({ a: "a", b: "b", c: "c", "f-nested": "f-nested" });
      expect([nestedF, topF]).toEqual(["success", "failed"]);
    });

    it("keeps the top-level follower while its own emitter commits", async () => {
      const { outcome, notes } = await nestedFollower([]);

      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toBeUndefined();
      expect(notes).toEqual({
        a: "a",
        b: "b",
        c: "c",
        f: "f",
        "f-nested": "f-nested",
      });
    });
  });

  it("fails the whole execution when a story's nested call is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const story = manifest("story", {
      outputKind: "story",
      trigger: { type: "auto" },
    });
    const child = manifest("child");
    const { outcome, notes } = await run(
      [story, child],
      {
        [story.name]: async (ctx) => {
          await call(ctx, "child");
          await note(ctx, "story");
          return ok({ narrativeOutput: "The story goes on." });
        },
        [child.name]: async (ctx) => {
          await note(ctx, "child");
          return ok();
        },
      },
      {
        proposalGuard: (proposal) =>
          (proposal.payload as { key?: unknown }).key === "child"
            ? "child rejected"
            : undefined,
      },
    );

    expect(outcome.status).toBe("failed");
    expect(notes).toEqual({});
  });

  it("settles a dropped nested run's journal and trigger entries apart from the same runtime at top level", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemoryStore();
    const timestamp = "2026-10-29T00:00:00.000Z";
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
    const story = manifest("story", { outputKind: "story" });
    const a = manifest("a");
    const f = manifest("f");
    const result = (
      runtime: RuntimeManifest,
      key?: string,
      output: Record<string, unknown> = {},
    ) => ({
      pluginId: "probe",
      runtimeId: runtime.name,
      runId: crypto.randomUUID(),
      turnId: input.turnId,
      status: "success" as const,
      output,
      toolCalls: [],
      durationMs: 1,
      timestamp,
      ...(key
        ? {
            pendingProposals: [
              {
                id: `write-${key}`,
                type: "plugin.data" as const,
                source: { pluginId: "probe", runtimeId: runtime.name },
                sessionId: SESSION,
                turnId: input.turnId,
                timestamp,
                payload: { namespace: "notes", key, value: key },
              },
            ],
          }
        : {}),
    });
    const message = (id: string) => ({
      id,
      sessionId: SESSION,
      turnId: input.turnId,
      sourceType: "runtime",
      sourcePluginId: "probe",
      sourceRuntimeId: f.name,
      role: "assistant",
      content: id,
      order: 1,
      createdAt: timestamp,
    });
    const storyRun = result(story, undefined, { narrativeOutput: "Story." });
    const nestedF = result(f, "f-nested");
    const aRun = result(a, "a");
    const topF = result(f, "f");

    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION,
      executionContext: {
        executionId: "exec",
        origin: "manual",
        countPolicy: "none",
      },
      runtimes: [story, a, f],
      // `f` ran nested under `a` and again at top level.
      results: [storyRun, nestedF, aRun, topF],
      commitUnits: [1, 2, 1],
      journalMessages: [message("nested f said"), message("top f said")],
      journalMessageRuns: {
        "nested f said": nestedF.runId,
        "top f said": topF.runId,
      },
      runtimeTriggers: [f.name, a.name, f.name],
      runtimeTriggerRuns: [nestedF.runId, aRun.runId, topF.runId],
      turnIds: [input.turnId],
      proposalGuard: (proposal) =>
        (proposal.payload as { key?: unknown }).key === "f-nested"
          ? "nested write rejected"
          : undefined,
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes).toEqual([
      expect.objectContaining({ runtimeId: f.name, runId: nestedF.runId }),
      expect.objectContaining({ runtimeId: a.name, runId: aRun.runId }),
    ]);
    expect(
      (await store.listPluginData(SESSION, "probe", "notes")).map(
        (row) => row.key,
      ),
    ).toEqual(["f"]);
    expect(
      (await store.listTurnMessages(SESSION)).map((row) => row.content),
    ).toEqual(["top f said"]);
    const ledger = await readRuntimeTriggerLedger(store, SESSION);
    expect(ledger.get(f.name)?.count).toBe(1);
    expect(ledger.has(a.name)).toBe(false);
  });

  it("fails the execution when a system parent's only story is nested in its rejected unit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const story = manifest("story", { outputKind: "story" });
    const { execution, outcome, notes } = await run(
      [parent, story],
      {
        [parent.name]: async (ctx) => {
          await call(ctx, "story");
          await note(ctx, "parent");
          return ok();
        },
        [story.name]: async (ctx) => {
          await note(ctx, "story");
          return ok({ narrativeOutput: "The story goes on." });
        },
      },
      {
        proposalGuard: (proposal) =>
          (proposal.payload as { key?: unknown }).key === "parent"
            ? "parent rejected"
            : undefined,
      },
    );

    expect(ids(execution.commit.results)).toEqual([story.name, parent.name]);
    expect(outcome.status).toBe("failed");
    expect(notes).toEqual({});
  });

  it("fails the execution when a nested setup run's unit has a rejected write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const story = manifest("story", {
      outputKind: "story",
      trigger: { type: "auto" },
    });
    const parent = manifest("parent", {
      stage: "post-turn",
      trigger: { type: "auto" },
    });
    // Already completed, so this execution does not schedule it: it runs
    // only nested, and `setupRan` never lists it.
    const setup = manifest("setup", { stage: "setup" });
    const { execution, outcome, notes } = await run(
      [story, parent, setup],
      {
        [story.name]: async () => ok({ narrativeOutput: "The story goes on." }),
        [parent.name]: async (ctx) => {
          await call(ctx, "setup");
          await note(ctx, "parent");
          return ok();
        },
        [setup.name]: async (ctx) => {
          await note(ctx, "setup");
          return ok();
        },
      },
      {
        setupRuntimes: {
          [setup.name]: {
            state: "done",
            resolution: "completed",
            generation: 1,
            attempts: 1,
            completedAt: "2026-10-29T00:00:00.000Z",
            pluginVersion: "0.0.0",
          },
        },
        proposalGuard: (proposal) =>
          (proposal.payload as { key?: unknown }).key === "parent"
            ? "parent rejected"
            : undefined,
      },
    );

    expect(execution.commit.results).toEqual([
      expect.objectContaining({ runtimeId: story.name }),
      expect.objectContaining({ runtimeId: setup.name, status: "success" }),
      expect.objectContaining({ runtimeId: parent.name, status: "success" }),
    ]);
    expect(execution.commit.setupRan ?? []).toEqual([]);
    expect(outcome.status).toBe("failed");
    expect(notes).toEqual({});
  });

  it("settles the jobs a surviving continuation holds back against a dropped unit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const story = manifest("story", {
      outputKind: "story",
      trigger: { type: "auto" },
    });
    const facts = manifest("facts", {
      stage: "pre-turn",
      trigger: { type: "auto" },
    });
    const asker = manifest("asker", {
      stage: "post-turn",
      trigger: { type: "auto" },
    });
    const detached = (id: string, extra: Partial<RuntimeManifest>) =>
      manifest(id, {
        stage: "post-turn",
        trigger: { type: "auto" },
        turnCompletion: { mode: "detached" },
        effects: { writes: ["plugin-data:self:notes"] },
        ...extra,
      } as Partial<RuntimeManifest>);
    const needsFacts = detached("needs-facts", { needs: [facts.name] });
    const readsFacts = detached("reads-facts", {
      inputs: { facts: { from: { runtime: facts.name }, required: false } },
    } as Partial<RuntimeManifest>);
    const { store, execution, outcome } = await run(
      [story, facts, asker, needsFacts, readsFacts],
      {
        [story.name]: async () => ok({ narrativeOutput: "The story goes on." }),
        [facts.name]: async (ctx) => {
          await note(ctx, "facts");
          return ok({ fact: "the gate is open" });
        },
        [asker.name]: async () => ({
          outcome: "suspended",
          reason: "Need an answer",
          resumeSchema: { type: "object" },
        }),
        [needsFacts.name]: async () => ok(),
        [readsFacts.name]: async () => ok(),
      },
      {
        proposalGuard: (proposal) =>
          (proposal.payload as { key?: unknown }).key === "facts"
            ? "facts rejected"
            : undefined,
      },
    );

    expect(
      execution.result.withheldRuntimeJobs?.map((job) => job.runtimeId),
    ).toEqual([needsFacts.name, readsFacts.name]);
    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      facts.name,
    ]);
    const [saved] = await store.listSuspensions(SESSION);
    const jobs = saved!.pendingContinuation.withheldRuntimeJobs as
      | readonly {
          readonly runtimeId: string;
          readonly upstreamResults: readonly RuntimeResult[];
        }[]
      | undefined;
    // The job that needs the dropped runtime is gone; the one that reads it
    // optionally stays and sees it as failed.
    expect(jobs?.map((job) => job.runtimeId)).toEqual([readsFacts.name]);
    expect(
      jobs?.[0]?.upstreamResults.find((item) => item.runtimeId === facts.name)
        ?.status,
    ).toBe("failed");
  });

  describe("a nested continuation in a dropped unit", () => {
    const story = manifest("story", {
      outputKind: "story",
      trigger: { type: "auto" },
    });
    const parent = manifest("parent", {
      stage: "post-turn",
      trigger: { type: "auto" },
    });
    const child = manifest("child");
    const handlers: Record<string, FunctionHandler> = {
      [story.name]: async () => ok({ narrativeOutput: "The story goes on." }),
      [parent.name]: async (ctx) => {
        await call(ctx, "child");
        await note(ctx, `parent-${ctx.turnId}`);
        return ok();
      },
      [child.name]: async (ctx) => {
        await note(ctx, `child-${ctx.turnId}`);
        if (ctx.resumedFromSuspensionId === undefined)
          return {
            outcome: "suspended",
            reason: "Need an answer",
            resumeSchema: { type: "object" },
          };
        return ok();
      },
    };
    const deps = (store: ReturnType<typeof createMemoryStore>) => ({
      store,
      llm: { generate: vi.fn() } as never,
      loadRuntime: async (runtime: RuntimeManifest) => ({
        manifest: runtime,
        promptTemplate: "",
        handler: handlers[runtime.name],
      }),
    });
    async function turn(
      store: ReturnType<typeof createMemoryStore>,
      n: number,
      rejectParent: boolean,
      // A turn without a player message (as the host's opening continuation
      // runs) leaves the history a standing suspension was taken under alone.
      playerMessage = true,
    ) {
      const turnInput = {
        ...input,
        turnId: `turn-${n}`,
        logicalTurnId: `logical-turn-${n}`,
        ...(playerMessage
          ? {}
          : { playerMessage: "", suppressPlayerMessage: true }),
      };
      const execution = await executeTurn(
        turnInput,
        [story, parent, child],
        deps(store),
      );
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: turnInput.turnId, durationMs: 0 },
        proposalGuard: (proposal) =>
          rejectParent &&
          (proposal.payload as { key?: unknown }).key === `parent-turn-${n}`
            ? "parent rejected"
            : undefined,
      });
      return { execution, outcome };
    }
    async function freshStore() {
      const store = createMemoryStore();
      await store.createSession({
        id: SESSION,
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: ["probe"],
        completedPlayerTurns: 0,
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
      });
      return store;
    }
    const keys = async (store: ReturnType<typeof createMemoryStore>) =>
      (await store.listPluginData(SESSION, "probe", "notes"))
        .map((row) => row.key)
        .sort();

    it("is never saved, and its turn counts as if the continuation were abandoned", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = await freshStore();
      const { execution, outcome } = await turn(store, 1, true);

      expect(execution.commit.suspensions).toHaveLength(1);
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
        child.name,
        parent.name,
      ]);
      expect(await store.listSuspensions(SESSION)).toEqual([]);
      expect(
        await store.getSuspension(execution.commit.suspensions![0]!.id),
      ).toBeNull();
      expect((await store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
      expect(await keys(store)).toEqual([]);
    });

    it("does not replace a standing continuation, which still resumes and commits", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = await freshStore();
      await turn(store, 1, false);
      const [standing] = await store.listSuspensions(SESSION);
      expect(standing).toBeDefined();
      expect(await keys(store)).toEqual(["parent-turn-1"]);

      const second = await turn(store, 2, true, false);
      expect(second.outcome.status).toBe("committed");
      expect(second.execution.commit.suspensions).toHaveLength(1);
      expect(
        (await store.listSuspensions(SESSION)).map((record) => record.id),
      ).toEqual([standing!.id]);
      // The dropped continuation ended turn 2, which counts; turn 1 still
      // waits for the standing one.
      expect((await store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
      // The host's resume route checks this before resuming.
      expect(
        await suspensionOutdatedReason(store, standing!, child),
      ).toBeUndefined();

      const resumed = await resumeSuspendedRuntime(
        standing!,
        {},
        child,
        deps(store),
      );
      const outcome = await commitExecution({
        store,
        execution: resumed,
        completion: {
          kind: "resume",
          turnId: standing!.turnId,
          suspensionId: standing!.id,
          pluginId: standing!.pluginId,
          runtimeId: standing!.runtimeId,
        },
      });
      expect(outcome.status).toBe("committed");
      expect(await keys(store)).toEqual(["child-turn-1", "parent-turn-1"]);
      expect((await store.getSession(SESSION))?.completedPlayerTurns).toBe(2);
    });

    it("leaves a standing continuation in place but outdated after another player turn", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = await freshStore();
      await turn(store, 1, false);
      const [standing] = await store.listSuspensions(SESSION);

      const second = await turn(store, 2, true);
      expect(second.outcome.status).toBe("committed");
      expect(
        (await store.listSuspensions(SESSION)).map((record) => record.id),
      ).toEqual([standing!.id]);
      // The dropped continuation ended its own turn, which counts.
      expect((await store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
      expect(await suspensionOutdatedReason(store, standing!, child)).toBe(
        "session-moved-on",
      );
    });
  });

  it("keeps the success path: the parent reads the child's output and both commit", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const child = manifest("child");
    const { execution, outcome, notes } = await run([parent, child], {
      [parent.name]: async (ctx) => {
        const nested = await call(ctx, "child");
        await note(ctx, "parent", String(nested.runtimeResults[0]?.output?.n));
        return ok();
      },
      [child.name]: async (ctx) => {
        await note(ctx, "child");
        return ok({ n: 7 });
      },
    });

    expect(outcome.status).toBe("committed");
    expect(ids(execution.commit.results)).toEqual([child.name, parent.name]);
    expect(execution.result.nestedRuntimeResults).toEqual([
      expect.objectContaining({ runtimeId: child.name, status: "success" }),
    ]);
    expect(notes).toEqual({ child: "child", parent: "7" });
  });

  it.each([true, false])(
    "commits a guard's nested call only when the guard skips (skip=%s)",
    async (skip) => {
      const guarded = manifest("guarded", {
        runtimeType: "agent",
        trigger: { type: "auto" },
      });
      const child = manifest("child");
      const { execution, notes } = await run(
        [guarded, child],
        {
          [child.name]: async (ctx) => {
            await note(ctx, "child");
            return ok();
          },
        },
        {
          guards: {
            [guarded.name]: async (ctx) => {
              await call(ctx, "child");
              return { skip };
            },
          },
          llm: {
            generate: vi.fn(async () => ({ content: "{}", toolCalls: [] })),
          },
        },
      );

      expect(ids(execution.commit.results)).toEqual(
        skip ? [child.name, guarded.name] : [guarded.name],
      );
      expect(notes).toEqual(skip ? { child: "child" } : {});
    },
  );

  it("drops a skipping guard's nested call with its own writes when a hook changes its status", async () => {
    const guarded = manifest("guarded", {
      runtimeType: "agent",
      trigger: { type: "auto" },
    });
    const child = manifest("child");
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "unskip-guard",
      event: "PostRuntime",
      handler: async (_context: unknown, payload: unknown) => {
        const { result } = payload as { result: RuntimeResult };
        if (result.runtimeId !== guarded.name || result.status !== "skipped")
          return { action: "continue" as const };
        return {
          action: "continue" as const,
          replace: {
            result: { ...result, status: "success", output: { ok: true } },
          },
        };
      },
    });
    const { execution, notes } = await run(
      [guarded, child],
      {
        [child.name]: async (ctx) => {
          await note(ctx, "child");
          return ok();
        },
      },
      {
        hookPipeline,
        guards: {
          [guarded.name]: async (ctx) => {
            await call(ctx, "child");
            await note(ctx, "guard");
            return { skip: true };
          },
        },
      },
    );

    expect(execution.commit.results).toEqual([
      expect.objectContaining({ runtimeId: guarded.name, status: "success" }),
    ]);
    expect(notes).toEqual({});
  });
});
