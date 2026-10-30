/**
 * A resumed runtime may suspend again. Its commit resolves the old record and
 * saves the new one in one transaction; the new record keeps the chain's
 * identity, so the resume that finally ends the chain counts the turn once,
 * releases the held-back jobs once and settles every leg's progress jobs.
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type {
  HandlerResult,
  RuntimeManifest,
  SubscriptionEvent,
} from "@covel/shared";
import type {
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { suspendTool } from "@covel/tools";
import {
  applySuspensionAbandonTx,
  classifyExecutionFaults,
  commitExecution,
  executeTurn,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
  settleAbandonedSuspensionJobs,
} from "../src/index.js";
import type { ExecutedRuntime, ExecutionDeps } from "../src/execution.js";
import {
  makeExecutor,
  prose,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const SESSION = "session";
const timestamp = "2026-10-29T00:00:00.000Z";
const input = {
  sessionId: SESSION,
  turnId: "player-turn",
  logicalTurnId: "logical-player-turn",
  playerMessage: "Ask the archivist",
  origin: "player" as const,
};
const ASK = { reason: "Need input", resumeSchema: { type: "object" } };

const later: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

async function session(phase: "playing" | "setup" = "playing") {
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe", "notes"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const eventBus = createEventBus();
  const events: SubscriptionEvent[] = [];
  eventBus.onEmit((event) => events.push(event));
  return { store, eventBus, events };
}

type Fixture = Awaited<ReturnType<typeof session>>;

async function commitResume(
  f: Fixture,
  execution: ExecutedRuntime,
  suspension: SuspensionRecord,
) {
  return commitExecution({
    store: f.store,
    eventBus: f.eventBus,
    execution: structuredClone(execution),
    completion: {
      kind: "resume",
      turnId: suspension.turnId,
      suspensionId: suspension.id,
      pluginId: suspension.pluginId,
      runtimeId: suspension.runtimeId,
    },
  });
}

async function pending(f: Fixture) {
  const list = await f.store.listSuspensions(SESSION);
  return list.filter((record) => record.resolvedAt === undefined);
}

const named = (f: Fixture, type: string) =>
  f.events.filter((event) => event.type === type);

/**
 * Turn → suspension A; resume A → suspension B; resume B → success. The
 * runtime is driven by `deps(leg)` for leg 0, 1 and 2.
 */
async function chain(
  f: Fixture,
  runtime: RuntimeManifest,
  deps: (leg: number) => ExecutionDeps,
  runtimes: readonly RuntimeManifest[] = [runtime, later],
) {
  const execution = await executeTurn(input, runtimes, deps(0));
  expect(
    (
      await commitExecution({
        store: f.store,
        eventBus: f.eventBus,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      })
    ).status,
  ).toBe("committed");
  const [first] = await pending(f);
  if (!first) throw new Error("expected a suspension");

  const again = await resumeSuspendedRuntime(first, {}, runtime, deps(1), {
    activeRuntimes: runtimes,
  });
  expect(again.result.status).toBe("suspended");
  return { first, again };
}

async function expectResuspended(
  f: Fixture,
  first: SuspensionRecord,
  again: ExecutedRuntime,
) {
  expect(again.commit.releasedRuntimeJobs).toBeUndefined();
  expect(again.commit.executionContext.countPolicy).toBe("none");
  f.events.length = 0;
  const outcome = await commitResume(f, again, first);
  expect(outcome.status).toBe("committed");

  const old = await f.store.getSuspension(first.id);
  expect(old?.resolvedAt).toEqual(expect.any(String));
  expect(old?.pendingContinuation.messages).toEqual([]);
  expect(old?.pendingContinuation.pendingProposals).toEqual([]);

  const [second, ...rest] = await pending(f);
  expect(rest).toEqual([]);
  expect(second!.id).not.toBe(first.id);
  expect(again.result.output).toMatchObject({ suspensionId: second!.id });
  expect(second!.pendingContinuation.executionContext).toEqual(
    first.pendingContinuation.executionContext,
  );
  expect(second!.pendingContinuation.takenUnder.playerTurns).toBe(
    first.pendingContinuation.takenUnder.playerTurns,
  );
  expect(second!.pendingContinuation.withheldRuntimeJobs).toEqual(
    first.pendingContinuation.withheldRuntimeJobs,
  );
  expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(0);
  expect(
    named(f, "turn.suspended").map(
      (event) => (event.payload as { suspensionId?: string }).suspensionId,
    ),
  ).toEqual([second!.id]);
  expect(named(f, "turn.resumed")).toEqual([]);
  return second!;
}

async function finish(
  f: Fixture,
  second: SuspensionRecord,
  runtime: RuntimeManifest,
  deps: ExecutionDeps,
  runtimes: readonly RuntimeManifest[] = [runtime, later],
) {
  const done = await resumeSuspendedRuntime(second, {}, runtime, deps, {
    activeRuntimes: runtimes,
  });
  expect(done.result.status).toBe("success");
  f.events.length = 0;
  expect((await commitResume(f, done, second)).status).toBe("committed");
  return done;
}

describe("an agent that suspends again on resume", () => {
  const asker: RuntimeManifest = {
    description: "test",
    name: "probe/asker",
    pluginId: "probe",
    runtimeType: "agent",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    tools: { builtin: ["suspend"] },
  };

  it("keeps the chain identity and counts the turn once, when the chain ends", async () => {
    const f = await session();
    const deps = (leg: number): ExecutionDeps => ({
      store: f.store,
      llm: queuedLLM(
        leg === 2
          ? [prose("All answered.")]
          : [toolCall("suspend", ASK, `call-${leg}`)],
      ),
      toolExecutor: makeExecutor([suspendTool]),
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "Ask.",
        handler: async () => ({ outcome: "success", value: {} }),
      }),
    });
    const { first, again } = await chain(f, asker, deps);
    expect(first.pendingContinuation.withheldRuntimeJobs).toHaveLength(1);
    const second = await expectResuspended(f, first, again);

    const done = await finish(f, second, asker, deps(2));
    expect(
      done.commit.releasedRuntimeJobs?.map((job) => job.runtimeId),
    ).toEqual([later.name]);
    expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
    expect(named(f, "turn.resumed")).toHaveLength(1);
    expect(await pending(f)).toEqual([]);
  });
});

describe("a function that suspends again on resume", () => {
  const asker: RuntimeManifest = {
    description: "test",
    name: "probe/asker",
    pluginId: "probe",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
  };

  function handlerDeps(
    f: Fixture,
    handler: (ctx: FunctionHandlerContext) => Promise<HandlerResult>,
  ) {
    return (): ExecutionDeps => ({
      store: f.store,
      llm: { generate: vi.fn() },
      loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        handler:
          manifest.name === asker.name
            ? handler
            : async () => ({
                outcome: "success",
                value: {},
              }),
      }),
    });
  }

  it("commits every leg's buffered writes once, when the chain ends", async () => {
    const f = await session();
    let firstId: string | undefined;
    const deps = handlerDeps(f, async (ctx) => {
      const leg =
        ctx.resumedFromSuspensionId === undefined
          ? 0
          : ctx.resumedFromSuspensionId === firstId
            ? 1
            : 2;
      await ctx.pluginData!.set("notes", `leg-${leg}`, leg);
      if (leg === 2) return { outcome: "success", value: {} };
      return {
        outcome: "suspended",
        reason: `question ${leg}`,
        resumeSchema: { type: "object" },
      };
    });
    const execution = await executeTurn(input, [asker, later], deps());
    await commitExecution({
      store: f.store,
      eventBus: f.eventBus,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    const [first] = await pending(f);
    firstId = first!.id;
    const again = await resumeSuspendedRuntime(first!, {}, asker, deps(), {
      activeRuntimes: [asker, later],
    });
    expect(again.result.status).toBe("suspended");
    const second = await expectResuspended(f, first!, again);
    expect(await f.store.listPluginData(SESSION, "probe", "notes")).toEqual([]);
    expect(second.pendingContinuation.pendingProposals).toHaveLength(2);

    const done = await finish(f, second, asker, deps());
    expect(
      done.commit.releasedRuntimeJobs?.map((job) => job.runtimeId),
    ).toEqual([later.name]);
    const notes = await f.store.listPluginData(SESSION, "probe", "notes");
    expect(notes.map((row) => row.key).sort()).toEqual([
      "leg-0",
      "leg-1",
      "leg-2",
    ]);
    expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
    expect(named(f, "turn.resumed")).toHaveLength(1);
  });

  describe("progress jobs", () => {
    function reportingDeps(f: Fixture) {
      let firstId: string | undefined;
      const deps = handlerDeps(f, async (ctx) => {
        const leg =
          ctx.resumedFromSuspensionId === undefined
            ? 0
            : ctx.resumedFromSuspensionId === firstId
              ? 1
              : 2;
        await ctx.progress!.report({
          jobId: `job-${leg}`,
          state: "running",
          sequence: 1,
        });
        if (leg === 2) return { outcome: "success", value: {} };
        return {
          outcome: "suspended",
          reason: `question ${leg}`,
          resumeSchema: { type: "object" },
        };
      });
      return {
        deps,
        setFirst: (id: string) => {
          firstId = id;
        },
      };
    }

    async function resuspended(f: Fixture) {
      const { deps, setFirst } = reportingDeps(f);
      const execution = await executeTurn(input, [asker], deps());
      await commitExecution({
        store: f.store,
        eventBus: f.eventBus,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      const [first] = await pending(f);
      setFirst(first!.id);
      const again = await resumeSuspendedRuntime(first!, {}, asker, deps(), {
        activeRuntimes: [asker],
      });
      expect((await commitResume(f, again, first!)).status).toBe("committed");
      const [second] = await pending(f);
      return { first: first!, second: second!, deps };
    }

    async function finalStates(f: Fixture, executionId: string) {
      const rows = await f.store.listJobStatus(SESSION, {
        progressScopeId: executionId,
      });
      const byJob = new Map<string, string[]>();
      for (const row of rows)
        byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row.state]);
      return byJob;
    }

    it("reports every leg under the suspended execution and settles each job once", async () => {
      const f = await session();
      const { first, second, deps } = await resuspended(f);
      const executionId =
        first.pendingContinuation.executionContext.executionId;
      await finish(f, second, asker, deps(), [asker]);
      const states = await finalStates(f, executionId);
      expect([...states.keys()].sort()).toEqual(["job-0", "job-1", "job-2"]);
      for (const [jobId, history] of states) {
        expect(
          history.filter((state) => state === "succeeded"),
          jobId,
        ).toHaveLength(1);
        expect(history.at(-1), jobId).toBe("succeeded");
      }
    });

    it("leaves every leg's jobs waiting for input while the chain is suspended", async () => {
      const f = await session();
      const { first } = await resuspended(f);
      const states = await finalStates(
        f,
        first.pendingContinuation.executionContext.executionId,
      );
      expect([...states.keys()].sort()).toEqual(["job-0", "job-1"]);
      for (const [jobId, history] of states)
        expect(history.at(-1), jobId).toBe("waiting-input");
    });

    it("takes back a leg's claimed success when its resume commit rolls back", async () => {
      const f = await session();
      let firstId: string | undefined;
      const deps = handlerDeps(f, async (ctx) => {
        if (ctx.resumedFromSuspensionId === undefined) {
          await ctx.progress!.report({
            jobId: "asked",
            state: "running",
            sequence: 1,
          });
          return {
            outcome: "suspended",
            reason: "question",
            resumeSchema: { type: "object" },
          };
        }
        expect(ctx.resumedFromSuspensionId).toBe(firstId);
        await ctx.progress!.report({
          jobId: "answered",
          state: "succeeded",
          sequence: 1,
        });
        await ctx.pluginData!.set("notes", "answer", "saved");
        return { outcome: "success", value: {} };
      });
      const execution = await executeTurn(input, [asker], deps());
      await commitExecution({
        store: f.store,
        eventBus: f.eventBus,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      const [first] = await pending(f);
      firstId = first!.id;
      const executionId =
        first!.pendingContinuation.executionContext.executionId;

      const resumed = await resumeSuspendedRuntime(first!, {}, asker, deps(), {
        activeRuntimes: [asker],
      });
      const rejected = await commitExecution({
        store: f.store,
        eventBus: f.eventBus,
        execution: structuredClone(resumed),
        extraInTx: async () => {
          throw new Error("commit rejected");
        },
        completion: {
          kind: "resume",
          turnId: first!.turnId,
          suspensionId: first!.id,
          pluginId: first!.pluginId,
          runtimeId: first!.runtimeId,
        },
      });
      expect(rejected.status).toBe("failed");
      expect(await f.store.listPluginData(SESSION, "probe", "notes")).toEqual(
        [],
      );
      // The suspension stays open, so its jobs wait for the retry.
      expect((await pending(f)).map((record) => record.id)).toEqual([
        first!.id,
      ]);
      let states = await finalStates(f, executionId);
      expect(states.get("asked")?.at(-1)).toBe("waiting-input");
      expect(states.get("answered")).toEqual(["succeeded", "waiting-input"]);

      const retried = await resumeSuspendedRuntime(first!, {}, asker, deps(), {
        activeRuntimes: [asker],
      });
      expect((await commitResume(f, retried, first!)).status).toBe("committed");
      states = await finalStates(f, executionId);
      expect(states.get("asked")?.at(-1)).toBe("succeeded");
      expect(states.get("answered")?.at(-1)).toBe("succeeded");
    });

    /**
     * Every leg claims its job `succeeded` before suspending; only the last
     * leg's writes land. Leg 0 is the first suspension, leg 1 a re-suspension.
     */
    async function claimedThenResuspended(f: Fixture) {
      let firstId: string | undefined;
      const deps = handlerDeps(f, async (ctx) => {
        const leg =
          ctx.resumedFromSuspensionId === undefined
            ? 0
            : ctx.resumedFromSuspensionId === firstId
              ? 1
              : 2;
        await ctx.progress!.report({
          jobId: `claimed-${leg}`,
          state: "succeeded",
          sequence: 1,
        });
        await ctx.pluginData!.set("notes", `leg-${leg}`, leg);
        if (leg === 2) return { outcome: "success", value: {} };
        return {
          outcome: "suspended",
          reason: `question ${leg}`,
          resumeSchema: { type: "object" },
        };
      });
      const execution = await executeTurn(input, [asker], deps());
      await commitExecution({
        store: f.store,
        eventBus: f.eventBus,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      });
      const [first] = await pending(f);
      firstId = first!.id;
      const executionId =
        first!.pendingContinuation.executionContext.executionId;
      expect((await finalStates(f, executionId)).get("claimed-0")).toEqual([
        "succeeded",
        "waiting-input",
      ]);
      const again = await resumeSuspendedRuntime(first!, {}, asker, deps(), {
        activeRuntimes: [asker],
      });
      expect((await commitResume(f, again, first!)).status).toBe("committed");
      const [second] = await pending(f);
      expect(await f.store.listPluginData(SESSION, "probe", "notes")).toEqual(
        [],
      );
      return { second: second!, executionId, deps };
    }

    const terminalEvents = (f: Fixture) =>
      named(f, "job-status.updated")
        .map((event) => event.payload as { jobId: string; state: string })
        .filter((payload) =>
          ["succeeded", "failed", "cancelled"].includes(payload.state),
        )
        .map(({ jobId, state }) => `${jobId}:${state}`)
        .sort();

    it("takes back a claimed success when the leg suspends again, and settles it once at the end", async () => {
      const f = await session();
      const { second, executionId, deps } = await claimedThenResuspended(f);
      let states = await finalStates(f, executionId);
      expect(states.get("claimed-0")).toEqual(["succeeded", "waiting-input"]);
      expect(states.get("claimed-1")).toEqual(["succeeded", "waiting-input"]);

      await finish(f, second, asker, deps(), [asker]);
      // `finish` clears the event log right before the final commit.
      expect(terminalEvents(f)).toEqual([
        "claimed-0:succeeded",
        "claimed-1:succeeded",
      ]);
      states = await finalStates(f, executionId);
      for (const jobId of ["claimed-0", "claimed-1"])
        expect(states.get(jobId), jobId).toEqual([
          "succeeded",
          "waiting-input",
          "succeeded",
        ]);
      expect(states.get("claimed-2")).toEqual(["succeeded"]);
      const notes = await f.store.listPluginData(SESSION, "probe", "notes");
      expect(notes.map((row) => row.key).sort()).toEqual([
        "leg-0",
        "leg-1",
        "leg-2",
      ]);
    });

    it("cancels a claimed success of a leg that suspended again when the chain is abandoned", async () => {
      const f = await session();
      const { second, executionId } = await claimedThenResuspended(f);
      const plan = await planSuspensionAbandon(f.store, second);
      await f.store.withTransaction((tx) =>
        applySuspensionAbandonTx(tx, plan, timestamp),
      );
      f.events.length = 0;
      await settleAbandonedSuspensionJobs(
        { store: f.store, eventBus: f.eventBus },
        second,
      );
      expect(terminalEvents(f)).toEqual([
        "claimed-0:cancelled",
        "claimed-1:cancelled",
      ]);
      const states = await finalStates(f, executionId);
      for (const jobId of ["claimed-0", "claimed-1"])
        expect(states.get(jobId), jobId).toEqual([
          "succeeded",
          "waiting-input",
          "cancelled",
        ]);
      expect(await f.store.listPluginData(SESSION, "probe", "notes")).toEqual(
        [],
      );
    });

    it("cancels every leg's jobs when the chain is abandoned", async () => {
      const f = await session();
      const { first, second } = await resuspended(f);
      const executionId =
        first.pendingContinuation.executionContext.executionId;
      const plan = await planSuspensionAbandon(f.store, second);
      await f.store.withTransaction((tx) =>
        applySuspensionAbandonTx(tx, plan, timestamp),
      );
      await settleAbandonedSuspensionJobs({ store: f.store }, second);
      const states = await finalStates(f, executionId);
      expect([...states.keys()].sort()).toEqual(["job-0", "job-1"]);
      for (const [jobId, history] of states)
        expect(history.at(-1), jobId).toBe("cancelled");
      expect((await f.store.getSession(SESSION))?.completedPlayerTurns).toBe(1);
    });
  });

  it("keeps a re-suspended setup runtime's attempt and its pending state", async () => {
    const f = await session("setup");
    const setup: RuntimeManifest = {
      ...asker,
      name: "probe/setup",
      version: "1.0.0",
      stage: "setup",
    };
    let firstId: string | undefined;
    const deps = (): ExecutionDeps => ({
      store: f.store,
      llm: { generate: vi.fn() },
      loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        handler: async (ctx) =>
          ctx.resumedFromSuspensionId === undefined ||
          ctx.resumedFromSuspensionId === firstId
            ? {
                outcome: "suspended",
                reason: "Need a name",
                resumeSchema: { type: "object" },
              }
            : { outcome: "success", value: {}, completion: "done" },
      }),
    });
    const execution = await executeTurn(
      { ...input, playerMessage: "" },
      [setup],
      deps(),
    );
    await commitExecution({
      store: f.store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    const attempts = async () =>
      (await f.store.listSetupAttempts(SESSION, { runtimeId: setup.name })).map(
        (attempt) => attempt.state,
      );
    expect(await attempts()).toEqual(["suspended"]);
    const [first] = await pending(f);
    firstId = first!.id;

    const again = await resumeSuspendedRuntime(first!, {}, setup, deps());
    expect(again.result.status).toBe("suspended");
    expect((await commitResume(f, again, first!)).status).toBe("committed");
    expect(await attempts()).toEqual(["suspended"]);
    const mirror = (await f.store.getSession(SESSION))?.setupRuntimes[
      setup.name
    ];
    expect(mirror).toMatchObject({ state: "pending" });
    expect((await f.store.getSession(SESSION))?.phase).toBe("setup");

    const [second] = await pending(f);
    const done = await resumeSuspendedRuntime(second!, {}, setup, deps());
    expect((await commitResume(f, done, second!)).status).toBe("committed");
    expect(await attempts()).toEqual(["success"]);
    expect(
      (await f.store.getSession(SESSION))?.setupRuntimes[setup.name],
    ).toMatchObject({ state: "done" });
  });

  it("is neutral for the fault latch", async () => {
    const f = await session();
    const deps = handlerDeps(f, async () => ({
      outcome: "suspended",
      reason: "again and again",
      resumeSchema: { type: "object" },
    }));
    const execution = await executeTurn(input, [asker], deps());
    await commitExecution({
      store: f.store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    const [first] = await pending(f);
    const again = await resumeSuspendedRuntime(first!, {}, asker, deps());
    const outcome = await commitResume(f, again, first!);
    expect(outcome.status).toBe("committed");
    expect(
      classifyExecutionFaults(again.commit.results, outcome).get(
        asker.pluginId,
      ),
    ).toEqual({ kind: "neutral" });
  });
});
