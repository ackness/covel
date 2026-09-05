import { describe, expect, it } from "vitest";
import type { SnapshotTraceEvent } from "@covel/shared";
import {
  getSourceTurnId,
  projectExecutionTurns,
} from "../execution-projection.js";
import { reconcileExecutionSteps } from "../snapshot-execution-steps.js";
import type { ExecutionStep, StreamMessage } from "../types.js";

const time = (hour: number) => `2026-09-05T0${hour}:00:00Z`;
const source: ExecutionStep[] = ["story", "tracker", "world"].map(
  (runtimeId) => ({
    runtimeId,
    pluginId: runtimeId,
    turnId: "source",
    status: runtimeId === "story" ? "completed" : "failed",
    attemptStatus: "committed",
    detail: runtimeId === "story" ? undefined : `${runtimeId} error`,
    startedAt: time(1),
  }),
);
const message: StreamMessage = {
  id: "story-message",
  role: "assistant",
  kind: "story",
  turnId: "source",
  content: "Story remains visible",
  timestamp: time(1),
};
function attempt(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    runtimeId: "tracker",
    pluginId: "tracker",
    turnId: "retry-1",
    sourceTurnId: "source",
    status: "completed",
    attemptStatus: "pending",
    startedAt: time(3),
    ...overrides,
  };
}
function trace(
  type: string,
  payload: Record<string, unknown>,
  turnId = "retry-1",
): SnapshotTraceEvent {
  return { type, turnId, payload, timestamp: time(3) };
}

describe("source turn execution projection", () => {
  it.each(["failed", "interrupted"] as const)(
    "keeps source commit permission after its retry attempt is %s",
    (attemptStatus) => {
      const projected = projectExecutionTurns(
        [message],
        [...source, attempt({ attemptStatus, status: "failed" })],
      );
      expect(projected.latestTurn?.sourceCommitted).toBe(true);
    },
  );
  it("does not borrow commit permission from a linked attempt when the source evidence is missing", () => {
    const projected = projectExecutionTurns(
      [message],
      [attempt({ attemptStatus: "committed" })],
    );
    expect(projected.latestTurn?.sourceCommitted).toBeUndefined();
  });
  it("keeps a selected task unresolved when its retry is skipped", () => {
    const status = "skipped";
    const skipped = attempt({
      runtimeId: "world",
      status,
      attemptStatus: "committed",
    });
    const rows = projectExecutionTurns(
      [message],
      [
        ...source,
        attempt({
          status: "failed",
          attemptStatus: "committed",
          detail: "dependency failed",
        }),
        skipped,
      ],
    ).turns[0].steps;
    expect(rows.find((step) => step.runtimeId === "world")).toMatchObject({
      status: "failed",
      detail: "world error",
    });
    expect(
      projectExecutionTurns([], [skipped]).turns[0].steps[0],
    ).toMatchObject({ status: "failed" });
    expect(skipped.status).toBe(status);
  });
  it("keeps suspended retries resumable without offering a duplicate retry", () => {
    const suspended = attempt({
      status: "suspended",
      attemptStatus: "committed",
    });
    expect(
      projectExecutionTurns([message], [...source, suspended]).turns[0].steps[1]
        .status,
    ).toBe("suspended");
    expect(
      projectExecutionTurns(
        [message],
        [...source, { ...suspended, attemptStatus: "failed" }],
      ).turns[0].steps[1].status,
    ).toBe("failed");
  });
  it("updates only the retried task, keeps story and other failures, and requires commit evidence", () => {
    const pending = attempt();
    const { turns } = projectExecutionTurns([message], [...source, pending]);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages[0].message).toBe(message);
    expect(turns[0].steps.map((step) => [step.runtimeId, step.status])).toEqual(
      [
        ["story", "completed"],
        ["tracker", "running"],
        ["world", "failed"],
      ],
    );
    expect(turns[0].steps[1].detail).toContain("reasonAwaitingCommit");
    expect(pending).toMatchObject({ turnId: "retry-1", status: "completed" });
    expect(source[1].status).toBe("failed");
    expect(
      projectExecutionTurns(
        [message],
        [...source, attempt({ attemptStatus: "committed" })],
      ).turns[0].steps[1].status,
    ).toBe("completed");
  });

  it("keeps historical position but selects the source of the latest attempt as current", () => {
    const laterMessage = {
      ...message,
      id: "later",
      turnId: "later-turn",
      timestamp: time(2),
    };
    const { turns, latestTurn } = projectExecutionTurns(
      [message, laterMessage],
      [...source, attempt()],
    );
    expect(turns.map((turn) => turn.turnId)).toEqual(["source", "later-turn"]);
    expect(latestTurn?.turnId).toBe("source");
    expect(latestTurn?.turnNumber).toBe(1);
  });

  it("resolves chained retry sources and uses attempt timestamps rather than merge order", () => {
    const latest = attempt({
      turnId: "retry-2",
      sourceTurnId: "retry-1",
      startedAt: time(4),
      status: "failed",
      detail: "new failure",
    });
    const { turns } = projectExecutionTurns(
      [message],
      [latest, ...source, attempt({ attemptStatus: "committed" })],
    );
    expect(turns).toHaveLength(1);
    expect(
      turns[0].steps.find((step) => step.runtimeId === "tracker"),
    ).toMatchObject({
      turnId: "source",
      status: "failed",
      detail: "new failure",
    });
    expect(
      getSourceTurnId(
        "a",
        new Map([
          ["a", "b"],
          ["b", "a"],
        ]),
      ),
    ).toBe("a");
  });

  it.each(["failed", "interrupted"] as const)(
    "does not turn uncommitted runtime success into a repaired task after %s",
    (attemptStatus) => {
      const row = projectExecutionTurns(
        [message],
        [...source, attempt({ attemptStatus })],
      ).turns[0].steps[1];
      expect(row.status).toBe("failed");
      expect(row.detail).toContain(
        attemptStatus === "failed" ? "reasonCommitFailed" : "reasonInterrupted",
      );
    },
  );
});

describe("retry attempt snapshot evidence", () => {
  it.each([true, false])(
    "records ordinary turn commit evidence independently of runtime failure, committed=%s",
    (committed) => {
      const events = [
        trace(
          "runtime.completed",
          { runtimeId: "story", status: "failed", error: "Story failed" },
          "source",
        ),
        trace("turn.completed", { committed }, "source"),
      ];
      const steps = reconcileExecutionSteps([], events, {
        state: committed ? "completed" : "failed",
        turnId: "source",
      });
      expect(steps[0].attemptStatus).toBe(committed ? "committed" : "failed");
      expect(projectExecutionTurns([], steps).latestTurn?.sourceCommitted).toBe(
        committed,
      );
    },
  );
  it("uses current execution status as original source commit evidence for an older snapshot", () => {
    const steps = reconcileExecutionSteps(
      [],
      [
        trace(
          "runtime.completed",
          { runtimeId: "tracker", status: "failed" },
          "source",
        ),
      ],
      { state: "completed", turnId: "source" },
    );
    expect(projectExecutionTurns([], steps).latestTurn?.sourceCommitted).toBe(
      true,
    );
  });
  const retriedTracker = (steps: ExecutionStep[]) =>
    steps.find(
      (step) => step.turnId === "retry-1" && step.runtimeId === "tracker",
    );
  const started = trace("turn.started", {
    recoveryAction: {
      type: "retry_failed_runtimes",
      payload: { retryFromTurnId: "source", runtimeIds: ["tracker", "world"] },
    },
  });
  const completed = trace("runtime.completed", {
    runtimeId: "tracker",
    pluginId: "tracker",
    status: "success",
  });

  it("restores batch source links from turn.started while retaining the actual attempt ID", () => {
    const steps = reconcileExecutionSteps(source, [started, completed], {
      state: "running",
      turnId: "retry-1",
    });
    expect(retriedTracker(steps)).toMatchObject({
      turnId: "retry-1",
      sourceTurnId: "source",
      status: "completed",
      attemptStatus: "pending",
    });
    expect(
      projectExecutionTurns([message], steps).turns[0].steps[1].status,
    ).toBe("running");
  });

  it("settles success after turn commit, including equal-timestamp unordered trace rows", () => {
    const steps = reconcileExecutionSteps(
      source,
      [trace("turn.completed", { committed: true }), completed, started],
      { state: "completed", turnId: "retry-1" },
    );
    expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
    expect(
      projectExecutionTurns([message], steps).turns[0].steps[1].status,
    ).toBe("completed");
  });

  it("uses status confirmation if the commit event is outside the snapshot window", () => {
    const steps = reconcileExecutionSteps(source, [started, completed], {
      state: "completed",
      turnId: "retry-1",
    });
    expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
  });

  it("preserves a running attempt by its actual ID, rather than interrupting its source ID", () => {
    const running = trace("runtime.started", {
      runtimeId: "tracker",
      sourceTurnId: "source",
    });
    const steps = reconcileExecutionSteps(source, [started, running], {
      state: "running",
      turnId: "retry-1",
    });
    expect(retriedTracker(steps)).toMatchObject({
      turnId: "retry-1",
      status: "running",
      attemptStatus: "pending",
    });
    expect(
      projectExecutionTurns([message], steps).turns[0].steps[1].status,
    ).toBe("running");
  });

  it("marks a completed runtime interrupted if its turn never committed before restart", () => {
    const steps = reconcileExecutionSteps(source, [started, completed], {
      state: "interrupted",
      turnId: "retry-1",
    });
    expect(retriedTracker(steps)).toMatchObject({
      status: "completed",
      attemptStatus: "interrupted",
    });
    expect(
      projectExecutionTurns([message], steps).turns[0].steps[1].status,
    ).toBe("failed");
  });

  it("uses the authoritative committed artifact even after a terminal reporting failure", () => {
    const steps = reconcileExecutionSteps(
      source,
      [started, completed, trace("turn.completed", { committed: false })],
      { state: "completed", turnId: "retry-1" },
    );
    expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
  });
  it.each([false, true])(
    "preserves positive commit trace evidence despite turn.failed, reverse=%s",
    (reverse) => {
      const terminal = [
        trace("turn.completed", { committed: true }),
        trace("turn.failed", { error: "Trace write failed" }),
      ];
      const steps = reconcileExecutionSteps(source, [
        started,
        completed,
        ...(reverse ? terminal.reverse() : terminal),
      ]);
      expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
    },
  );
  it("accepts API committed evidence after a late turn.failed", () => {
    const steps = reconcileExecutionSteps(
      source,
      [started, completed, trace("turn.failed", {})],
      { state: "completed", turnId: "retry-1" },
    );
    expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
  });
  it("keeps cached original commit evidence when a legacy snapshot omits the flag", () => {
    const steps = reconcileExecutionSteps(
      source,
      [
        trace(
          "runtime.completed",
          { runtimeId: "tracker", status: "failed" },
          "source",
        ),
        started,
        trace("runtime.completed", { runtimeId: "tracker", status: "failed" }),
      ],
      { state: "failed", turnId: "retry-1" },
    );
    expect(
      projectExecutionTurns([message], steps).latestTurn?.sourceCommitted,
    ).toBe(true);
  });
  it("shows selected tasks during preparation before any runtime starts", () => {
    const steps = reconcileExecutionSteps(source, [started], {
      state: "running",
      turnId: "retry-1",
    });
    expect(
      steps
        .filter((step) => step.turnId === "retry-1")
        .map((step) => step.runtimeId),
    ).toEqual(["tracker", "world"]);
    expect(
      projectExecutionTurns([message], steps)
        .turns[0].steps.slice(1)
        .map((step) => step.status),
    ).toEqual(["running", "running"]);
  });
  it("does not confuse a background job source with a retry relationship", () => {
    const steps = reconcileExecutionSteps(source, [
      trace(
        "runtime.completed",
        { runtimeId: "background", status: "success", sourceTurnId: "source" },
        "job-turn",
      ),
    ]);
    expect(steps.at(-1)?.sourceTurnId).toBeUndefined();
    expect(
      projectExecutionTurns([message], steps).turns.map((turn) => turn.turnId),
    ).toContain("job-turn");
  });
  it("accepts authoritative committed status despite a legacy terminal lacking the flag", () => {
    const steps = reconcileExecutionSteps(
      source,
      [started, completed, trace("turn.completed", {})],
      { state: "completed", turnId: "retry-1" },
    );
    expect(retriedTracker(steps)?.attemptStatus).toBe("committed");
  });
});
