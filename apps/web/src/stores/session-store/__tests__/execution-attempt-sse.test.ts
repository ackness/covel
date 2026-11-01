// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  exportSessionCheckpoint,
  validateBrowserCheckpoint,
  replaceSessionFromCheckpoint,
} from "@covel/store";
import type { SnapshotTraceEvent } from "@covel/shared";
import type { SseEnvelope } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import { projectExecutionTurns } from "../execution-projection.js";
import {
  buildSnapshotExecutionSteps,
  reconcileExecutionSteps,
} from "../snapshot-execution-steps.js";
import type { SessionAction } from "../types.js";
import { subscribeToast } from "@/lib/toast-channel.js";

function harness(retrying = true) {
  let state = {
    ...initialState,
    executing: true,
    executionSteps: [
      {
        runtimeId: "tracker",
        pluginId: "tracker",
        turnId: "source",
        status: "failed" as const,
        attemptStatus: "committed" as const,
        startedAt: "2026-09-05T00:00:00Z",
      },
    ],
  } as typeof initialState;
  const deps: SseEventHandlerDeps = {
    dispatch: (action: SessionAction) => {
      state = reducer(state, action);
    },

    sessionIdRef: { current: "session" },
    // Intentionally not updated: React may batch every event before rendering.
    stateRef: { current: state },

    lastBackfilledTurnIdRef: { current: "attempt" },
  };
  const handler = createSseEventHandler(deps);
  return {
    getState: () => state,
    dispatch: deps.dispatch,
    send: (type: string, payload: Record<string, unknown>) =>
      handler({
        type,
        eventId: type,
        requestId: "request",
        traceId: "trace",
        flowId: "flow",
        seq: 1,
        sessionId: "session",
        turnId: "attempt",
        timestamp: "2026-09-05T01:00:00Z",
        payload: {
          ...(retrying
            ? { sourceTurnId: "source", runtimeIds: ["tracker"] }
            : {}),
          runtimeId: "tracker",
          pluginId: "tracker",
          ...payload,
        },
      } as SseEnvelope),
  };
}

it.each(["setup", "narrative", "post-turn"])(
  "retains the %s stage from start through terminal events",
  (stage) => {
    const h = harness(false);
    h.send("runtime.started", { stage });
    h.send("runtime.failed", { error: "401 Unauthorized" });
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt"),
    ).toMatchObject({ stage, status: "failed" });
    h.send("runtime.completed", { status: "success" });
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt"),
    ).toMatchObject({ stage, status: "completed" });
  },
);

it.each([undefined, "invalid-stage", { stage: "setup" }])(
  "does not infer a stage from missing or invalid metadata: %j",
  (stage) => {
    const h = harness(false);
    h.send("runtime.started", { stage });
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt")
        ?.stage,
    ).toBeUndefined();
  },
);

it.each(["quota", "auth", "unknown"])(
  "preserves %s from runtime.failed",
  (errorKind) => {
    const h = harness(false);
    const failureTarget = { provider: "deepseek", model: "failed-model" };
    h.send("runtime.failed", {
      errorKind,
      error: "provider detail",
      failureTarget,
    });
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt"),
    ).toMatchObject({
      status: "failed",
      errorKind,
      detail: "provider detail",
      failureTarget,
    });
    h.send("runtime.completed", { status: "success" });
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt")
        ?.errorKind,
    ).toBeUndefined();
    expect(
      h.getState().executionSteps.find((step) => step.turnId === "attempt")
        ?.failureTarget,
    ).toBeUndefined();
  },
);

describe("provider completion does not imply a visible partial story", () => {
  it.each([
    { finishReason: "length", notices: 0 },
    { finishReason: "other", notices: 0 },
    { finishReason: "stop", notices: 0 },
  ])(
    "shows $notices notice(s) for a response that finished with $finishReason",
    ({ finishReason, notices }) => {
      const shown: string[] = [];
      const unsubscribe = subscribeToast((toast) => shown.push(toast.kind));
      try {
        harness(false).send("llm.responded", { finishReason });
      } finally {
        unsubscribe();
      }
      expect(shown).toHaveLength(notices);
    },
  );
});

describe("SSE retry commit settlement", () => {
  it.each(["player-aborted", "commit rejected"])(
    "retains committed history and player input when a later execution fails: %s",
    (abortReason) => {
      const h = harness(false);
      for (const [id, role, turnId] of [
        ["old-story", "assistant", "previous"],
        ["input", "user", "attempt"],
        ["story", "assistant", "attempt"],
        ["form", "assistant", "attempt"],
      ] as const) {
        h.dispatch({
          type: "ADD_MESSAGE",
          message: { id, role, turnId, content: id, timestamp: "2026-10-06" },
        });
      }
      h.send("execution.completed", { committed: false, abortReason });
      expect(h.getState().messages.map((message) => message.id)).toEqual([
        "old-story",
        "input",
        "story",
        "form",
      ]);
    },
  );
  it("keeps the durable terminal when a batched action stream delivers an old queue and handoff", () => {
    const h = harness(false);
    const job = {
      jobId: "job",
      progressScopeId: "job",
      sequence: 4,
      state: "succeeded",
      data: { durableStatus: "succeeded", originTurnId: "attempt" },
    };
    h.send("job-status.updated", job);
    h.send("job-status.updated", {
      ...job,
      sequence: 0,
      state: "queued",
      data: { durableStatus: "queued", originTurnId: "attempt" },
    });
    h.send("runtime.deferred", { jobId: "job", sourceTurnId: "attempt" });
    expect(
      h.getState().executionSteps.find((step) => step.jobId === "job"),
    ).toMatchObject({
      status: "completed",
      jobState: "succeeded",
      durableJobStatus: { sequence: 4 },
    });
  });
  it("atomically replaces the inflight failure summary and ignores a late replay", () => {
    const h = harness();
    const inflight = {
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["tracker", "remaining"],
    };
    h.send("runtime.started", inflight);
    h.send("runtime.completed", { ...inflight, status: "success" });
    h.send("execution.completed", {
      committed: true,
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["remaining"],
    });
    h.send("runtime.completed", { ...inflight, status: "success" });
    expect(h.getState().executionSteps[1]!.sourceFailedRuntimeIds).toEqual([
      "remaining",
    ]);
    expect(
      projectExecutionTurns(
        [],
        h.getState().executionSteps,
      ).latestTurn?.steps.map((step) => [step.runtimeId, step.status]),
    ).toEqual([
      ["tracker", "completed"],
      ["remaining", "failed"],
    ]);
  });
  it("preserves a committed result after late transport errors or repeated runtime events", () => {
    const h = harness();
    h.send("runtime.started", {});
    h.send("runtime.completed", { status: "success" });
    h.send("execution.completed", { committed: true });
    h.send("error.occurred", { message: "Trace write failed" });
    h.send("runtime.completed", { status: "success" });
    expect(h.getState().executionSteps[1]!.attemptStatus).toBe("committed");
    expect(
      projectExecutionTurns([], h.getState().executionSteps).latestTurn
        ?.sourceCommitted,
    ).toBe(true);
  });
  it.each([true, false])(
    "settles original turns as well as retries, committed=%s",
    (committed) => {
      const h = harness(false);
      h.send("runtime.started", {});
      h.send("runtime.completed", {
        status: "failed",
        error: "Narration failed",
      });
      h.send("execution.completed", { committed });
      expect(h.getState().executionSteps[1]).toMatchObject({
        turnId: "attempt",
        attemptStatus: committed ? "committed" : "failed",
      });
      expect(h.getState().executionSteps[1]!.sourceTurnId).toBeUndefined();
      expect(
        projectExecutionTurns([], h.getState().executionSteps).latestTurn
          ?.sourceCommitted,
      ).toBe(committed);
    },
  );
  it.each([undefined, "true"])(
    "treats a missing/non-boolean committed flag as uncommitted, committed=%s",
    (committed) => {
      const h = harness(false);
      h.send("runtime.started", {});
      h.send("runtime.completed", { status: "success" });
      h.send("execution.completed", { committed });
      expect(h.getState().executionSteps[1]!.attemptStatus).toBe("failed");
      expect(h.getState().executionError).toBe(
        "__i18n:session.reasonExecutionCommitFailed__",
      );
    },
  );
  it("shows the selected task during preparation before runtime.started", () => {
    const h = harness();
    h.send("execution.started", { runtimeCount: 1 });
    expect(h.getState().executionSteps[1]).toMatchObject({
      turnId: "attempt",
      sourceTurnId: "source",
      attemptStatus: "pending",
      status: "running",
    });
  });
  it.each([true, false])(
    "settles consecutive runtime/turn events atomically, committed=%s",
    (committed) => {
      const h = harness();
      h.send("runtime.started", {});
      h.send("runtime.completed", { status: "success" });
      expect(
        projectExecutionTurns([], h.getState().executionSteps).turns[0]!
          .steps[0]!.status,
      ).toBe("running");
      h.send("execution.completed", { committed });
      expect(h.getState().executionSteps).toHaveLength(2);
      expect(h.getState().executionSteps[0]).toMatchObject({
        turnId: "source",
        status: "failed",
      });
      expect(h.getState().executionSteps[1]).toMatchObject({
        turnId: "attempt",
        sourceTurnId: "source",
        status: "completed",
        attemptStatus: committed ? "committed" : "failed",
      });
      expect(
        projectExecutionTurns([], h.getState().executionSteps).turns[0]!
          .steps[0]!.status,
      ).toBe(committed ? "completed" : "failed");
    },
  );

  it("does not display a successful runtime as recovered after execution error", () => {
    const h = harness();
    h.send("runtime.started", {});
    h.send("runtime.completed", { status: "success" });
    h.send("error.occurred", { message: "Unable to save" });
    expect(h.getState().executionSteps[1]!.attemptStatus).toBe("failed");
    expect(
      projectExecutionTurns([], h.getState().executionSteps).turns[0]!.steps[0]!
        .status,
    ).toBe("failed");
  });

  it("maps error.occurred code session_busy to an i18n sentinel execution error", () => {
    const h = harness();
    h.send("error.occurred", {
      message: "Session is busy, please retry",
      code: "session_busy",
    });
    expect(h.getState().executionError).toBe(
      "__i18n:session.reasonSessionBusy__",
    );
  });

  it.each([
    ["input_already_committed", "session.reasonInputAlreadyCommitted"],
    ["retry_source_stale", "session.reasonRetryStale"],
    ["retry_target_not_failed", "session.reasonRetryStale"],
    ["recovery_unavailable", "session.reasonRetryStale"],
  ])("maps the refusal code %s to the player's language", (code, key) => {
    const h = harness();
    h.send("error.occurred", { message: "Server text", code });
    expect(h.getState().executionError).toBe(`__i18n:${key}__`);
  });

  it("keeps the raw message for a code it does not know", () => {
    const h = harness();
    h.send("error.occurred", {
      message: "Unable to save",
      code: "constructor",
    });
    expect(h.getState().executionError).toBe("Unable to save");
  });

  it("keeps the raw message when error.occurred carries no code", () => {
    const h = harness();
    h.send("error.occurred", { message: "Unable to save" });
    expect(h.getState().executionError).toBe("Unable to save");
  });
});

it("keeps an outer run running when a nested run completes", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "a" });
  h.send("runtime.started", { runId: "b" });
  h.send("runtime.completed", { runId: "b", status: "success" });
  expect(
    h.getState().executionSteps.filter((step) => step.turnId === "attempt"),
  ).toEqual([
    expect.objectContaining({ runId: "a", status: "running" }),
    expect.objectContaining({ runId: "b", status: "completed" }),
  ]);
});

it("shows successful resumed runs as completed instead of retaining the earlier suspension", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "original" });
  h.send("runtime.completed", { runId: "original", status: "suspended" });
  h.send("runtime.started", {
    runId: "continuation",
    resumed: true,
    resumeSourceRunId: "original",
  });
  const displayed = () =>
    projectExecutionTurns([], h.getState().executionSteps).turns.find(
      (turn) => turn.turnId === "attempt",
    )?.steps;
  expect(displayed()).toEqual([
    expect.objectContaining({ runId: "continuation", status: "running" }),
  ]);
  h.send("runtime.completed", { runId: "continuation", status: "success" });
  expect(displayed()).toEqual([
    expect.objectContaining({
      runId: "continuation",
      status: "completed",
      resumed: true,
    }),
  ]);
  h.send("turn.resumed", {
    suspensionId: "suspension",
    runId: "continuation",
    resumeSourceRunId: "original",
    status: "success",
  });
  expect(displayed()).toEqual([
    expect.objectContaining({ runId: "continuation", status: "completed" }),
  ]);
  expect(
    h.getState().executionSteps.find((step) => step.runId === "original")
      ?.status,
  ).toBe("suspended");
});

it("supersedes an earlier suspension when only the committed resume notification marks the continuation", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "original" });
  h.send("runtime.completed", { runId: "original", status: "suspended" });
  h.send("runtime.started", { runId: "continuation" });
  h.send("runtime.completed", { runId: "continuation", status: "success" });
  h.send("turn.resumed", {
    suspensionId: "suspension",
    runId: "continuation",
    resumeSourceRunId: "original",
    status: "success",
  });
  expect(
    projectExecutionTurns([], h.getState().executionSteps).turns.find(
      (turn) => turn.turnId === "attempt",
    )?.steps,
  ).toEqual([
    expect.objectContaining({
      runId: "continuation",
      status: "completed",
      resumed: true,
    }),
  ]);
});

it.each([
  ["success", "completed"],
  ["suspended", "suspended"],
] as const)(
  "lets a later resume finishing with %s replace an earlier failed resume",
  (status, expected) => {
    const h = harness(false);
    h.send("runtime.started", { runId: "original" });
    h.send("runtime.completed", { runId: "original", status: "suspended" });
    h.send("runtime.started", {
      runId: "first-resume",
      resumed: true,
      resumeSourceRunId: "original",
    });
    h.send("runtime.failed", { runId: "first-resume", error: "timeout" });
    h.send("runtime.failed", {
      runId: "original",
      error: "Saved work could not commit",
    });
    const displayed = () =>
      projectExecutionTurns([], h.getState().executionSteps).turns.find(
        (turn) => turn.turnId === "attempt",
      )?.steps;
    expect(displayed()).toEqual([
      expect.objectContaining({ runId: "first-resume", status: "failed" }),
    ]);
    h.send("runtime.started", {
      runId: "second-resume",
      resumed: true,
      resumeSourceRunId: "original",
    });
    expect(displayed()).toEqual([
      expect.objectContaining({ runId: "second-resume", status: "running" }),
    ]);
    h.send("runtime.completed", { runId: "second-resume", status });
    expect(displayed()).toEqual([
      expect.objectContaining({ runId: "second-resume", status: expected }),
    ]);
  },
);

it("still reports a failed nested run of the runtime after a later resume succeeds", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "original" });
  h.send("runtime.started", { runId: "nested" });
  h.send("runtime.failed", { runId: "nested", error: "nested failure" });
  h.send("runtime.completed", { runId: "original", status: "suspended" });
  h.send("runtime.started", {
    runId: "continuation",
    resumed: true,
    resumeSourceRunId: "original",
  });
  h.send("runtime.completed", { runId: "continuation", status: "success" });
  expect(
    projectExecutionTurns([], h.getState().executionSteps).turns.find(
      (turn) => turn.turnId === "attempt",
    )?.steps,
  ).toEqual([expect.objectContaining({ runId: "nested", status: "failed" })]);
});

it("keeps an independent saved child suspended across another invocation's resume and checkpoint recovery", async () => {
  const h = harness(false);
  const store = createMemoryStore();
  const traces: SnapshotTraceEvent[] = [];
  const timestamp = "2026-09-05T01:00:00.000Z";
  try {
    await store.createSession({
      id: "session",
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      activePlugins: ["tracker"],
      completedPlayerTurns: 0,
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.saveTurnResult({
      id: "result",
      sessionId: "session",
      turnId: "attempt",
      origin: "player",
      commitStatus: "committed",
      runtimeResults: [],
      durationMs: 0,
      createdAt: timestamp,
    });
    const send = async (type: string, payload: Record<string, unknown>) => {
      const event = {
        type,
        turnId: "attempt",
        timestamp: new Date(
          Date.parse(timestamp) + traces.length,
        ).toISOString(),
        payload: { runtimeId: "tracker", pluginId: "tracker", ...payload },
      };
      traces.push(event);
      h.send(type, payload);
      await store.addTraceEvent({
        id: `trace-${traces.length}`,
        sessionId: "session",
        traceId: "trace",
        turnId: event.turnId,
        type,
        payload: event.payload,
        createdAt: event.timestamp,
      });
    };
    await send("runtime.started", { runtimeId: "parent", runId: "parent" });
    await send("runtime.started", { runId: "top" });
    await send("runtime.started", { runId: "saved-child" });
    await send("runtime.completed", {
      runId: "saved-child",
      status: "success",
    });
    await send("runtime.completed", { runId: "top", status: "suspended" });
    await send("runtime.completed", {
      runtimeId: "parent",
      runId: "parent",
      status: "suspended",
    });
    await send("runtime.completed", {
      runId: "saved-child",
      status: "suspended",
    });
    const cached = h.getState().executionSteps;
    await send("runtime.started", {
      runId: "continuation",
      resumed: true,
      resumeSourceRunId: "top",
    });
    await send("runtime.completed", {
      runId: "continuation",
      status: "success",
    });
    await send("turn.resumed", {
      suspensionId: "top-suspension",
      runId: "continuation",
      resumeSourceRunId: "top",
    });
    const check = (
      steps: typeof cached,
      childStatus: "suspended" | "completed",
    ) => {
      expect(
        steps.filter(
          (step) => step.turnId === "attempt" && step.runtimeId === "tracker",
        ),
      ).toEqual([
        expect.objectContaining({ runId: "top", status: "suspended" }),
        expect.objectContaining({ runId: "saved-child", status: childStatus }),
        expect.objectContaining({
          runId: "continuation",
          status: "completed",
          resumeSourceRunId: "top",
        }),
      ]);
      expect(
        projectExecutionTurns([], steps)
          .turns.find((turn) => turn.turnId === "attempt")
          ?.steps.find((step) => step.runtimeId === "tracker")?.status,
      ).toBe(childStatus);
    };
    check(h.getState().executionSteps, "suspended");
    check(buildSnapshotExecutionSteps(traces), "suspended");
    const checkpoint = validateBrowserCheckpoint(
      JSON.parse(
        JSON.stringify(
          await exportSessionCheckpoint(store, "session", {
            revision: 1,
            actionId: "reload",
          }),
        ),
      ),
    );
    await replaceSessionFromCheckpoint(store, checkpoint);
    const recovered = (await store.listTraceEvents("session")).map((row) => ({
      type: row.type,
      turnId: row.turnId,
      timestamp: row.createdAt,
      payload: row.payload as SnapshotTraceEvent["payload"],
    }));
    check(buildSnapshotExecutionSteps(recovered), "suspended");
    check(reconcileExecutionSteps(cached, recovered), "suspended");
    await send("runtime.completed", {
      runId: "saved-child",
      status: "success",
    });
    await send("runtime.completed", {
      runtimeId: "parent",
      runId: "parent",
      status: "success",
    });
    check(h.getState().executionSteps, "completed");
    check(buildSnapshotExecutionSteps(traces), "completed");
  } finally {
    await store.close();
  }
});

it("does not assign a resume notification to an unrelated saved child when its start was missed", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "saved-child" });
  h.send("runtime.completed", { runId: "saved-child", status: "suspended" });
  const before = h.getState().executionSteps;
  h.send("turn.resumed", { suspensionId: "top-suspension" });
  expect(h.getState().executionSteps).toEqual(before);
  h.send("turn.resumed", {
    suspensionId: "top-suspension",
    runId: "continuation",
    resumeSourceRunId: "top",
  });
  expect(
    h.getState().executionSteps.filter((step) => step.turnId === "attempt"),
  ).toEqual([
    expect.objectContaining({ runId: "saved-child", status: "suspended" }),
    expect.objectContaining({ runId: "continuation", status: "completed" }),
  ]);
  expect(
    projectExecutionTurns([], h.getState().executionSteps).turns.find(
      (turn) => turn.turnId === "attempt",
    )?.steps,
  ).toEqual([
    expect.objectContaining({ runId: "saved-child", status: "suspended" }),
  ]);
});

it.each([
  ["success", "completed"],
  ["failed", "failed"],
  ["skipped", "skipped"],
] as const)(
  "corrects one held child to %s while preserving its independent twin",
  (status, expected) => {
    const h = harness(false);
    h.send("runtime.started", { runId: "top" });
    h.send("runtime.started", { runId: "saved-child" });
    h.send("runtime.completed", { runId: "top", status: "success" });
    h.send("runtime.completed", { runId: "saved-child", status: "success" });
    h.send("runtime.completed", { runId: "saved-child", status: "suspended" });
    const event =
      status === "failed"
        ? "runtime.failed"
        : status === "skipped"
          ? "runtime.skipped"
          : "runtime.completed";
    const payload = {
      runId: "saved-child",
      status,
      ...(status === "failed" ? { error: "Saved work could not commit" } : {}),
      ...(status === "skipped" ? { reason: "suspension-abandoned" } : {}),
    };
    h.send(event, payload);
    h.send(event, payload);
    expect(
      h.getState().executionSteps.filter((step) => step.turnId === "attempt"),
    ).toEqual([
      expect.objectContaining({ runId: "top", status: "completed" }),
      expect.objectContaining({ runId: "saved-child", status: expected }),
    ]);
    const steps = projectExecutionTurns(
      [],
      h.getState().executionSteps,
    ).turns.find((turn) => turn.turnId === "attempt")?.steps;
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.status).toBe(
      status === "skipped" ? "completed" : expected,
    );
  },
);

it("applies a dropped nested run correction despite a committed same-runtime top-level run", () => {
  const h = harness(false);
  h.send("runtime.started", { runId: "top" });
  h.send("runtime.started", { runId: "child" });
  h.send("runtime.completed", { runId: "child", status: "success" });
  h.send("runtime.completed", { runId: "top", status: "success" });
  for (let i = 0; i < 2; i++)
    h.send("runtime.failed", {
      runId: "child",
      status: "failed",
      error: "Commit rejected",
    });
  expect(
    h.getState().executionSteps.filter((step) => step.turnId === "attempt"),
  ).toEqual([
    expect.objectContaining({ runId: "top", status: "completed" }),
    expect.objectContaining({ runId: "child", status: "failed" }),
  ]);
  expect(
    projectExecutionTurns([], h.getState().executionSteps).turns.find(
      (turn) => turn.turnId === "attempt",
    )?.steps,
  ).toEqual([expect.objectContaining({ runId: "child", status: "failed" })]);
});
