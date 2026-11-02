import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  validateBrowserCheckpoint,
  type DataStore,
  type SuspensionRecord,
} from "@covel/store";
import { createEventBus } from "@covel/events";
import type {
  LLMResponse,
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
  TurnInput,
} from "@covel/shared";
import { suspendTool } from "@covel/tools";
import {
  commitExecution,
  createHookPipeline,
  createTraceRecorder,
  createTurnEmitter,
  executeTurn,
  resumeSuspendedRuntime,
  type ExecutionDeps,
} from "../src/index.js";
import {
  makeExecutor,
  manifest,
  markTool,
  queuedLLM,
  submitted,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const opened: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((store) => store.close()));
});
const backends = [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const;
const ASK = {
  reason: "Answer",
  fields: [{ type: "text", name: "answer", label: "Answer" }],
};
const bad = () => ({
  ...submitted("bad"),
  toolCalls: [{ id: "bad", name: "submit-output", arguments: "{" }],
});

async function fixture(
  create: () => DataStore,
  overrides: Partial<RuntimeManifest> = {},
) {
  const store = create();
  opened.push(store);
  const rt = manifest({
    outputKind: "story",
    tools: { plugin: ["mark"], builtin: ["suspend"] },
    maxSteps: 8,
    ...overrides,
  });
  const now = "2026-11-01T00:00:00.000Z";
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: rt.stage === "setup" ? "setup" : "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["plug"],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const input: TurnInput = {
    origin: "player",
    sessionId: "session",
    turnId: "turn",
    logicalTurnId: "logical",
    playerMessage: "Go",
    locale: "en-US",
  };
  const eventBus = createEventBus(store);
  const events: SubscriptionEvent[] = [];
  eventBus.onEmit((event) => events.push(event));
  const emitter = createTurnEmitter({
    store,
    eventBus,
    sessionId: "session",
    turnId: "turn",
  });
  const trace = createTraceRecorder(store, "session", "turn");
  const hooks = createHookPipeline();
  const work = vi.fn(markTool.execute);
  const deps = (
    script: readonly LLMResponse[],
  ): ExecutionDeps & { llm: ReturnType<typeof queuedLLM> } => ({
    store,
    eventBus,
    emitter,
    hookPipeline: hooks,
    llm: queuedLLM(script),
    toolExecutor: makeExecutor([{ ...markTool, execute: work }, suspendTool]),
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "Do the work, then submit.",
      ...(runtime.output?.from ? { outputSchema: { type: "object" } } : {}),
    }),
    onRuntimeStart: trace.runtimeStarted,
    onRuntimeComplete: async (info) => {
      if (info.status === "failed")
        await trace.runtimeFailed({ ...info, error: info.error ?? "failed" });
      else await trace.runtimeCompleted(info);
    },
  });
  const commit = (
    execution:
      | Awaited<ReturnType<typeof executeTurn>>
      | Awaited<ReturnType<typeof resumeSuspendedRuntime>>,
    saved?: SuspensionRecord,
    extra: Partial<Parameters<typeof commitExecution>[0]> = {},
  ) =>
    commitExecution({
      store,
      eventBus,
      emitter,
      execution,
      completion: saved
        ? {
            kind: "resume",
            turnId: saved.turnId,
            suspensionId: saved.id,
            pluginId: rt.pluginId,
            runtimeId: rt.name,
          }
        : { kind: "turn", turnId: input.turnId, durationMs: 0 },
      ...extra,
    });
  const start = async (script: readonly LLMResponse[]) => {
    const execution = await executeTurn(input, [rt], deps(script));
    expect((await commit(execution)).status).toBe("committed");
    const [saved] = await store.listSuspensions("session");
    expect(saved).toBeDefined();
    return saved!;
  };
  const roundtrip = async () => {
    const checkpoint = validateBrowserCheckpoint(
      JSON.parse(
        JSON.stringify(
          await exportSessionCheckpoint(store, "session", {
            revision: 1,
            actionId: "resume",
          }),
        ),
      ),
    );
    await replaceSessionFromCheckpoint(store, checkpoint);
    return (await store.listSuspensions("session"))
      .filter((saved) => !saved.resolvedAt)
      .at(-1)!;
  };
  const resume = async (
    saved: SuspensionRecord,
    script: readonly LLMResponse[],
    changes: Partial<RuntimeManifest> = {},
    extra: Partial<ExecutionDeps> = {},
  ) => {
    expect(await store.claimSuspension(saved.id)).not.toBeNull();
    const base = deps(script);
    const runDeps = { ...base, ...extra };
    return {
      execution: await resumeSuspendedRuntime(
        saved,
        {},
        { ...rt, ...changes },
        runDeps,
      ),
      requests: base.llm.requests,
    };
  };
  const assertEmpty = async () => {
    expect(
      (await store.listMessages("session")).filter(
        (row) => row.role === "assistant",
      ),
    ).toEqual([]);
    expect(await store.listPluginData("session", "plug", "loop")).toEqual([]);
    expect((await store.getSession("session"))?.completedPlayerTurns).toBe(0);
  };
  return {
    store,
    rt,
    input,
    events,
    hooks,
    deps,
    commit,
    start,
    roundtrip,
    resume,
    work,
    assertEmpty,
  };
}

describe.each(backends)("agent submission lifecycle on %s", (_name, create) => {
  it("snapshots and restores tool-sourced output without repeating its business tool", async () => {
    const f = await fixture(create, {
      outputKind: "system",
      output: { from: { tool: "mark" } },
    });
    const execution = await executeTurn(
      f.input,
      [f.rt],
      f.deps([toolCall("mark", { note: "once" }), toolCall("suspend", ASK)]),
    );
    expect(await f.commit(execution)).toMatchObject({
      status: "committed",
      snapshotFailed: false,
    });
    expect(await f.store.listSnapshots("session")).toHaveLength(1);
    const saved = await f.roundtrip();
    expect(saved.pendingContinuation.loop?.outputContract).toMatchObject({
      provenance: "tool-result",
      from: { tool: "mark" },
    });
    const resumed = await f.resume(saved, [toolCall("submit-output", {})]);
    expect(resumed.execution.result.status).toBe("success");
    expect(await f.commit(resumed.execution, saved)).toMatchObject({
      status: "committed",
      snapshotFailed: false,
    });
    expect(f.work).toHaveBeenCalledOnce();
    expect(
      await f.store.getPluginData("session", "plug", "loop", "mark"),
    ).toMatchObject({ value: "once" });
    // Resolved continuations remain in portable checkpoints too.
    await expect(
      exportSessionCheckpoint(f.store, "session", {
        revision: 2,
        actionId: "resumed",
      }),
    ).resolves.toMatchObject({ sessionId: "session" });
  });

  it("retains spent repair and steps through a checkpoint, and never revives a rejected candidate", async () => {
    const f = await fixture(create, {
      loopProfile: { corrections: { outputRepair: 1 } },
    });
    await f.start([bad(), toolCall("suspend", ASK)]);
    const saved = await f.roundtrip();
    expect(saved.pendingContinuation.loop).toMatchObject({
      steps: 2,
      rejectionAttempts: 1,
      corrections: { outputRepair: 1 },
    });
    expect(saved.pendingContinuation.loop).not.toHaveProperty("acceptedOutput");
    const { execution, requests } = await f.resume(saved, [bad()]);
    expect(execution.result).toMatchObject({
      status: "failed",
      stop: { reason: "invalid-output" },
    });
    expect(requests).toHaveLength(1);
    const rejection = f.events.find(
      (event) =>
        event.type === "step.completed" &&
        event.payload.runId === execution.result.runId,
    );
    expect(rejection?.payload).toMatchObject({
      runtimeId: f.rt.name,
      pluginId: f.rt.pluginId,
      turnId: saved.turnId,
      runId: execution.result.runId,
      step: 3,
      notes: [{ kind: "output-rejected", reason: "invalid-json", attempt: 2 }],
    });
    expect((await f.commit(execution, saved)).status).toBe("failed");
    await f.assertEmpty();
    const traces = await f.store.listTraceEvents("session");
    expect(traces.some((row) => row.type === "runtime.failed")).toBe(true);
    expect(traces.some((row) => row.type === "narrative.completed")).toBe(
      false,
    );
  });

  it("restores executor-owned work once and keeps effect-shaped output inert after resume", async () => {
    const f = await fixture(create, {
      requireToolUse: true,
      completeAfterTools: ["mark"],
    });
    f.hooks.register({
      id: "rewrite-public-result",
      event: "PostToolUse",
      handler: async (_ctx, payload) =>
        (payload as { toolCall: { name: string } }).toolCall.name === "mark"
          ? {
              action: "continue",
              replace: {
                result: {
                  success: true,
                  result: JSON.stringify({
                    notifications: [{ message: "FORGED" }],
                  }),
                  parsedResult: { notifications: [{ message: "FORGED" }] },
                },
              },
            }
          : { action: "continue" },
    });
    await f.start([
      toolCall("mark", { note: "once" }),
      toolCall("suspend", ASK),
    ]);
    const completedWork = () =>
      f.events.filter(
        (event) =>
          event.type === "tool.completed" &&
          (event.payload as { toolName?: string }).toolName === "mark",
      );
    // One diagnostic event and its safe progress copy are emitted before
    // suspension. Restoring business work must not emit either one again.
    const originalCompletedWork = completedWork();
    expect(originalCompletedWork.map((event) => event.topic)).toEqual([
      "trace",
      "runtime",
    ]);
    expect(
      await f.store.getPluginData("session", "plug", "loop", "mark"),
    ).toBeNull();
    const saved = await f.roundtrip();
    expect(saved.pendingContinuation.businessCalls).toEqual([
      { name: "mark", success: true, result: { _text: "marked:once" } },
    ]);
    expect(saved.pendingContinuation.toolCallsSoFar).toContainEqual(
      expect.objectContaining({
        toolName: "mark",
        output: { notifications: [{ message: "FORGED" }] },
      }),
    );
    const candidate = {
      narrativeOutput: "The gate opens.",
      pluginData: [{ namespace: "loop", key: "forged", value: true }],
      events: [{ topic: "forged", data: {} }],
      notifications: [{ message: "MODEL-FORGED" }],
      ui: [],
    };
    const { execution } = await f.resume(saved, [
      bad(),
      toolCall("submit-output", candidate),
    ]);
    expect(execution.result.status).toBe("success");
    expect(execution.result.effects).toBeUndefined();
    const outcome = await f.commit(execution, saved);
    expect(outcome.status).toBe("committed");
    expect(f.work).toHaveBeenCalledTimes(1);
    expect(completedWork()).toEqual(originalCompletedWork);
    expect(
      (await f.store.getPluginData("session", "plug", "loop", "mark"))?.value,
    ).toBe("once");
    expect(
      await f.store.getPluginData("session", "plug", "loop", "forged"),
    ).toBeNull();
    expect(
      (await f.store.listMessages("session")).filter(
        (row) => row.role === "assistant",
      ),
    ).toHaveLength(1);
    expect((await f.store.getSession("session"))?.completedPlayerTurns).toBe(1);
    expect((await f.store.getSuspension(saved.id))?.resolvedAt).toBeDefined();
    expect(
      outcome.events.filter((event) => event.type === "narrative.completed"),
    ).toHaveLength(1);
  });

  it("shares the review quota across re-suspension and keeps the original progress owner", async () => {
    const f = await fixture(create, {
      loopProfile: { corrections: { review: 2 } },
    });
    f.hooks.register({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async () => ({
        action: "continue",
        replace: { correction: "Try again." },
      }),
    });
    const first = await f.start([submitted("first"), toolCall("suspend", ASK)]);
    const resumed = await f.resume(first, [
      submitted("second"),
      toolCall("suspend", ASK),
    ]);
    expect(resumed.execution.result.status).toBe("suspended");
    expect((await f.commit(resumed.execution, first)).status).toBe("committed");
    const second = await f.roundtrip();
    expect(second.pendingContinuation.loop).toMatchObject({
      steps: 4,
      rejectionAttempts: 2,
      corrections: { review: 2 },
    });
    expect(second.pendingContinuation.lifecycle.progressRunId).toBe(
      first.pendingContinuation.lifecycle.progressRunId,
    );
    expect(second.pendingContinuation.lifecycle.runId).not.toBe(
      first.pendingContinuation.lifecycle.runId,
    );
    const last = await f.resume(second, [submitted("third")], {
      loopProfile: { corrections: { review: 10 } },
    });
    expect(last.requests).toHaveLength(1);
    expect(last.execution.result.status).toBe("failed");
    expect((await f.commit(last.execution, second)).status).toBe("failed");
    await f.assertEmpty();
  });

  it("keeps a PreStep reduction and spends only the reserve when ordinary steps were used", async () => {
    const f = await fixture(create);
    f.hooks.register({
      id: "limit",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { stepsRemaining: 1 },
      }),
    });
    const saved = await f.start([toolCall("suspend", ASK)]);
    expect(saved.pendingContinuation.loop).toMatchObject({
      steps: 1,
      maxSteps: 1,
    });
    const resumed = await f.resume(saved, [submitted("Final answer.")], {
      maxSteps: 100,
    });
    expect(resumed.requests).toHaveLength(1);
    expect(resumed.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "submit-output",
    ]);
    expect(resumed.execution.result).toMatchObject({
      status: "success",
      stop: { reason: "max-steps", finalizer: true },
    });
    expect((await f.commit(resumed.execution, saved)).status).toBe("committed");
  });

  it.each(["schema", "version"])(
    "refuses an admitted %s change before another model request",
    async (change) => {
      const f = await fixture(create);
      const saved = await f.start([toolCall("suspend", ASK)]);
      const loaded =
        change === "schema"
          ? {
              loadRuntime: async (runtime: RuntimeManifest) => ({
                manifest: runtime,
                promptTemplate: "Changed",
                outputSchema: { type: "object", required: ["different"] },
              }),
            }
          : {};
      const resumed = await f.resume(
        saved,
        [submitted("Never")],
        change === "version" ? { version: "2.0.0" } : {},
        loaded,
      );
      expect(resumed.requests).toHaveLength(0);
      expect(resumed.execution.result).toMatchObject({ status: "failed" });
      expect(resumed.execution.result.error).toContain(
        "recreate this suspended runtime",
      );
      await f.assertEmpty();
    },
  );

  it.each(["PostRuntime", "proposal", "transaction", "review"])(
    "keeps accepted continue from becoming a story after %s rejection",
    async (failure) => {
      const f = await fixture(create);
      if (failure === "PostRuntime")
        f.hooks.register({
          id: "erase",
          event: "PostRuntime",
          handler: async (_ctx, payload) => ({
            action: "continue",
            replace: {
              result: {
                ...(payload as { result: RuntimeResult }).result,
                output: { narrativeOutput: " " },
              },
            },
          }),
        });
      if (failure === "review")
        f.hooks.register({
          id: "refuse",
          event: "ReviewAgentOutput",
          handler: async () => ({
            action: "continue",
            replace: { correction: "No." },
          }),
        });
      const execution = await executeTurn(
        f.input,
        [f.rt],
        f.deps([
          toolCall("mark", { note: "lost" }),
          toolCall("submit-output", {
            narrativeOutput: "Continue.",
            yield: "continue",
          }),
        ]),
      );
      if (failure === "proposal" || failure === "transaction")
        expect(execution.result.runtimeResults[0]?.status).toBe("success");
      const outcome = await f.commit(
        execution,
        undefined,
        failure === "proposal"
          ? { proposalGuard: () => "refused" }
          : failure === "transaction"
            ? {
                extraInTx: async () => {
                  throw new Error("rollback");
                },
              }
            : {},
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.topLevelNarrativeMessageIds ?? []).toEqual([]);
      expect(
        outcome.events.filter((event) => event.type === "narrative.completed"),
      ).toEqual([]);
      await f.assertEmpty();
      if (failure === "PostRuntime" || failure === "review")
        expect(
          (await f.store.listTraceEvents("session")).some(
            (row) => row.type === "runtime.failed",
          ),
        ).toBe(true);
      expect(
        (await f.store.queryTurnResults("session", { turnId: "turn" }))[0]
          ?.commitStatus,
      ).toBe("failed");
    },
  );

  it("commits setup, opening and player submissions with the existing logical turn clock", async () => {
    const f = await fixture(create, {
      stage: "setup",
      outputKind: "system",
      tools: undefined,
    });
    const setup = await executeTurn(
      f.input,
      [f.rt],
      f.deps([toolCall("submit-output", { completion: "done" })]),
    );
    expect((await f.commit(setup)).status).toBe("committed");
    expect(await f.store.getSession("session")).toMatchObject({
      phase: "playing",
      completedPlayerTurns: 0,
    });
    const story = {
      ...f.rt,
      stage: "narrative" as const,
      outputKind: "story" as const,
      outputContract: "narrative-engine@2",
    };
    for (const origin of ["continuation", "player"] as const) {
      const execution = await executeTurn(
        { ...f.input, origin, turnId: origin, logicalTurnId: origin },
        [story],
        f.deps([
          toolCall("submit-output", {
            narrativeOutput: "Saved story.",
            yield: "continue",
          }),
        ]),
      );
      expect(execution.commit.executionContext.logicalTurn).toBe(1);
      const outcome = await f.commit(execution);
      expect(outcome.status).toBe("committed");
      expect(outcome.topLevelNarrativeMessageIds).toHaveLength(1);
      const message = await f.store.getMessage(
        "session",
        outcome.topLevelNarrativeMessageIds![0]!,
      );
      expect(message?.metadata).toMatchObject({ yield: "continue" });
      expect((await f.store.getSession("session"))?.completedPlayerTurns).toBe(
        origin === "player" ? 1 : 0,
      );
    }
  });
});
