// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SnapshotTraceEvent } from "@covel/shared";
import { projectExecutionTurns } from "../execution-projection.js";
import {
  buildSnapshotExecutionSteps,
  reconcileExecutionSteps,
} from "../snapshot-execution-steps.js";

const running = {
  runtimeId: "story",
  pluginId: "story",
  turnId: "turn-1",
  status: "running" as const,
};
function event(
  type: string,
  payload: Record<string, unknown>,
): SnapshotTraceEvent {
  return {
    type,
    turnId: "turn-1",
    timestamp: "2026-09-05T04:00:00Z",
    payload: { runtimeId: "story", pluginId: "story", ...payload },
  };
}

describe("authoritative execution recovery", () => {
  it("recovers setup stage from persisted starts and preserves it through terminal-only refreshes", () => {
    const steps = buildSnapshotExecutionSteps([
      event("runtime.failed", { error: "401 Unauthorized" }),
      event("runtime.started", { stage: "setup" }),
    ]);
    expect(steps).toEqual([
      expect.objectContaining({ stage: "setup", status: "failed" }),
    ]);
    // The browser cache retains metadata even if a later trace window only has the terminal.
    expect(
      reconcileExecutionSteps(steps, [
        event("runtime.completed", { status: "success" }),
      ]),
    ).toEqual([
      expect.objectContaining({ stage: "setup", status: "completed" }),
    ]);
  });

  it.each([undefined, "invalid-stage", { stage: "setup" }])(
    "does not assign setup to a trace with missing or invalid stage: %j",
    (stage) => {
      expect(
        buildSnapshotExecutionSteps([
          event("runtime.started", { stage }),
          event("runtime.failed", { error: "401 Unauthorized" }),
        ])[0]?.stage,
      ).toBeUndefined();
    },
  );
  it("restores why a runtime was skipped after refresh", () => {
    expect(
      buildSnapshotExecutionSteps([
        event("runtime.completed", {
          status: "skipped",
          reason: "upstream-failed",
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        status: "skipped",
        detail: "upstream-failed",
      }),
    ]);
  });

  it.each(["quota", "auth", "unknown"])(
    "restores the %s remedy after refresh",
    (errorKind) => {
      const failureTarget = { provider: "deepseek", model: "failed-model" };
      expect(
        buildSnapshotExecutionSteps([
          event("runtime.failed", {
            errorKind,
            error: "provider detail",
            failureTarget,
          }),
        ]),
      ).toEqual([
        expect.objectContaining({
          status: "failed",
          errorKind,
          detail: "provider detail",
          failureTarget,
        }),
      ]);
    },
  );
  it("settles terminal events even when same-millisecond random IDs sort before start", () => {
    expect(
      buildSnapshotExecutionSteps([
        event("runtime.completed", { status: "success" }),
        event("runtime.started", {}),
      ]),
    ).toEqual([expect.objectContaining({ status: "completed" })]);
  });
  it("does not restore stale browser running over a completed server step", () => {
    expect(
      reconcileExecutionSteps(
        [running],
        [event("runtime.completed", { status: "success" })],
        { state: "completed", turnId: "turn-1" },
      ),
    ).toEqual([expect.objectContaining({ status: "completed" })]);
  });
  it.each(["failed", "skipped", "suspended"])(
    "preserves runtime.completed payload status %s and error",
    (status) => {
      expect(
        buildSnapshotExecutionSteps([
          event("runtime.completed", { status, error: "reason" }),
        ]),
      ).toEqual([expect.objectContaining({ status, detail: "reason" })]);
    },
  );
  it("settles interrupted foreground spinners while preserving detached work", () => {
    const detached = { ...running, runtimeId: "background", detached: true };
    expect(
      reconcileExecutionSteps([running, detached], [], {
        state: "interrupted",
        turnId: "turn-1",
      }),
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        detail: "__i18n:session.reasonInterrupted__",
      }),
      expect.objectContaining(detached),
    ]);
  });
  it("does not guess interruption when server state is unknown", () => {
    expect(reconcileExecutionSteps([running], [])).toEqual([running]);
  });
  it("keeps the current running turn and settles only older orphaned rows", () => {
    expect(
      reconcileExecutionSteps([running, { ...running, turnId: "turn-2" }], [], {
        state: "running",
        turnId: "turn-2",
      }),
    ).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ turnId: "turn-2", status: "running" }),
    ]);
  });
});

it("recovers separate runs and settles only the run named by the terminal event", () => {
  const steps = buildSnapshotExecutionSteps([
    event("runtime.started", { runId: "a" }),
    event("runtime.started", { runId: "b" }),
    event("runtime.completed", { runId: "b", status: "success" }),
  ]);
  expect(steps).toEqual([
    expect.objectContaining({ runId: "a", status: "running" }),
    expect.objectContaining({ runId: "b", status: "completed" }),
  ]);
  expect(
    reconcileExecutionSteps(steps, [
      event("runtime.failed", { runId: "a", error: "Failure" }),
    ]),
  ).toEqual([
    expect.objectContaining({ runId: "a", status: "failed" }),
    expect.objectContaining({ runId: "b", status: "completed" }),
  ]);
});

it("adopts a snapshot run id into a legacy local row and merges the same run", () => {
  const events = [
    event("runtime.completed", { runId: "a", status: "success" }),
  ];
  const steps = reconcileExecutionSteps([running], events);
  expect(steps).toEqual([
    expect.objectContaining({ runId: "a", status: "completed" }),
  ]);
  expect(reconcileExecutionSteps(steps, events)).toEqual(steps);
});

it.each(["success", "suspended"])(
  "supersedes earlier suspensions when a recovered continuation finishes with %s",
  (status) => {
    const traces = [
      event("runtime.started", { runId: "original" }),
      event("runtime.completed", { runId: "original", status: "suspended" }),
      {
        ...event("runtime.started", { runId: "continuation", resumed: true }),
        timestamp: "2026-09-05T04:00:01Z",
      },
      {
        ...event("runtime.completed", { runId: "continuation", status }),
        timestamp: "2026-09-05T04:00:02Z",
      },
    ];
    const steps = buildSnapshotExecutionSteps(traces);
    expect(steps).toHaveLength(2);
    expect(projectExecutionTurns([], steps).turns[0]?.steps).toEqual([
      expect.objectContaining({
        runId: "continuation",
        status: status === "success" ? "completed" : "suspended",
        resumed: true,
      }),
    ]);
    const cached = [
      { ...running, runId: "original", status: "suspended" as const },
    ];
    expect(
      projectExecutionTurns(
        [],
        reconcileExecutionSteps(cached, traces.slice(2)),
      ).turns[0]?.steps,
    ).toEqual([
      expect.objectContaining({
        runId: "continuation",
        status: status === "success" ? "completed" : "suspended",
      }),
    ]);
  },
);

it("keeps the cached start of a recovered continuation when the snapshot only carries its terminal event", () => {
  const traces = [
    event("runtime.started", { runId: "original" }),
    event("runtime.completed", { runId: "original", status: "suspended" }),
    {
      ...event("runtime.started", { runId: "continuation", resumed: true }),
      timestamp: "2026-09-05T04:00:01Z",
    },
    {
      ...event("runtime.completed", {
        runId: "continuation",
        status: "success",
      }),
      timestamp: "2026-09-05T04:00:02Z",
    },
  ];
  const cached = buildSnapshotExecutionSteps(traces);
  const terminalOnly = buildSnapshotExecutionSteps(traces.slice(3));
  const steps = reconcileExecutionSteps(cached, traces.slice(3));
  expect(steps).toEqual([
    expect.objectContaining({
      runId: "original",
      status: "suspended",
    }),
    expect.objectContaining({
      runId: "continuation",
      status: "completed",
      startedAt: "2026-09-05T04:00:01Z",
    }),
  ]);
  expect(terminalOnly[0]?.startedAt).toBeUndefined();
  expect(projectExecutionTurns([], steps).turns[0]?.steps).toEqual([
    expect.objectContaining({ runId: "continuation", status: "completed" }),
  ]);
});

it.each([
  ["success", "completed"],
  ["suspended", "suspended"],
] as const)(
  "lets a recovered resume finishing with %s replace an earlier failed resume",
  (status, expected) => {
    const at = (second: number) => `2026-09-05T04:00:0${second}Z`;
    const traces = [
      event("runtime.started", { runId: "original" }),
      event("runtime.completed", { runId: "original", status: "suspended" }),
      {
        ...event("runtime.started", { runId: "first-resume", resumed: true }),
        timestamp: at(1),
      },
      {
        ...event("runtime.failed", {
          runId: "first-resume",
          error: "timeout",
        }),
        timestamp: at(2),
      },
      {
        ...event("runtime.started", { runId: "second-resume", resumed: true }),
        timestamp: at(3),
      },
      {
        ...event("runtime.completed", { runId: "second-resume", status }),
        timestamp: at(4),
      },
    ];
    const shown = [
      expect.objectContaining({ runId: "second-resume", status: expected }),
    ];
    expect(
      projectExecutionTurns([], buildSnapshotExecutionSteps(traces)).turns[0]
        ?.steps,
    ).toEqual(shown);
    // A browser cache that already holds the failed resume adopts the rest.
    const cached = buildSnapshotExecutionSteps(traces.slice(0, 4));
    expect(projectExecutionTurns([], cached).turns[0]?.steps).toEqual([
      expect.objectContaining({ runId: "first-resume", status: "failed" }),
    ]);
    expect(
      projectExecutionTurns(
        [],
        reconcileExecutionSteps(cached, traces.slice(4)),
      ).turns[0]?.steps,
    ).toEqual(shown);
  },
);
