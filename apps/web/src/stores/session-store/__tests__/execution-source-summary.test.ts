import { describe, expect, it } from "vitest";
import type { SnapshotTraceEvent } from "@covel/shared";
import { projectExecutionTurns } from "../execution-projection.js";
import { reconcileExecutionSteps } from "../snapshot-execution-steps.js";
import type { ExecutionStep } from "../types.js";

const scope = {
  sourceTurnId: "source",
  sourceCommitted: true,
  sourceFailedRuntimeIds: ["b", "c"],
  runtimeIds: ["b"],
};
function event(
  type: string,
  payload: Record<string, unknown>,
): SnapshotTraceEvent {
  return {
    type,
    turnId: "attempt",
    timestamp: "2026-09-05T03:00:00Z",
    payload: { ...scope, ...payload },
  };
}
function step(overrides: Partial<ExecutionStep>): ExecutionStep {
  return {
    runtimeId: "b",
    pluginId: "",
    turnId: "attempt",
    sourceTurnId: "source",
    sourceCommitted: true,
    sourceFailedRuntimeIds: ["b", "c"],
    status: "completed",
    attemptStatus: "committed",
    startedAt: "2026-09-05T03:00:00Z",
    ...overrides,
  };
}

describe("execution source summaries outside the trace window", () => {
  it("keeps missing unselected C retryable after B succeeds in a fresh browser", () => {
    const raw = reconcileExecutionSteps(
      [],
      [
        event("runtime.completed", { runtimeId: "b", status: "success" }),
        event("turn.completed", {
          committed: true,
          sourceFailedRuntimeIds: ["c"],
        }),
      ],
      { state: "completed", turnId: "attempt" },
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({
      turnId: "attempt",
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["c"],
    });
    const { latestTurn } = projectExecutionTurns([], raw);
    expect(latestTurn?.sourceCommitted).toBe(true);
    expect(latestTurn?.turnId).toBe("source");
    expect(latestTurn?.steps.map((row) => [row.runtimeId, row.status])).toEqual(
      [
        ["b", "completed"],
        ["c", "failed"],
      ],
    );
  });

  it("replaces an older summary instead of resurrecting cached failed A as failed or successful", () => {
    const old = step({
      runtimeId: "a",
      turnId: "old-attempt",
      status: "failed",
      sourceFailedRuntimeIds: ["a", "b", "c"],
      startedAt: "2026-09-05T02:00:00Z",
    });
    const original = {
      ...old,
      turnId: "source",
      sourceTurnId: undefined,
      sourceCommitted: undefined,
    };
    const current = step({ sourceFailedRuntimeIds: ["c"] });
    const projected = projectExecutionTurns(
      [],
      [current, original, old],
    ).latestTurn;
    expect(projected?.steps.map((row) => row.runtimeId)).toEqual(["b", "c"]);
    expect(old.status).toBe("failed");
    expect(original.status).toBe("failed");
  });

  it("keeps successful retained rows while adding a missing failure from the latest ledger", () => {
    const sourceSuccess = step({
      runtimeId: "a",
      turnId: "source",
      sourceTurnId: undefined,
      sourceCommitted: undefined,
      startedAt: "2026-09-05T01:00:00Z",
    });
    const projected = projectExecutionTurns(
      [],
      [sourceSuccess, step({ sourceFailedRuntimeIds: ["c"] })],
    ).latestTurn;
    expect(projected?.steps.map((row) => [row.runtimeId, row.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "failed"],
    ]);
  });

  it.each([false, true])(
    "uses terminal summary over inflight events regardless of input order, reverse=%s",
    (reverse) => {
      const events = [
        event("turn.completed", {
          committed: true,
          sourceFailedRuntimeIds: ["c"],
        }),
        event("llm.calling", { runtimeId: "b" }),
      ];
      const raw = reconcileExecutionSteps(
        [],
        reverse ? events.reverse() : events,
        { state: "completed", turnId: "attempt" },
      );
      const projected = projectExecutionTurns([], raw).latestTurn;
      // The success event fell out of the window. Hide the obsolete failure copy;
      // do not invent a successful result merely because the task left the ledger.
      expect(
        projected?.steps.map((row) => [row.runtimeId, row.status]),
      ).toEqual([["c", "failed"]]);
    },
  );

  it("restores pending selected tasks from scoped non-lifecycle events alone", () => {
    const raw = reconcileExecutionSteps(
      [],
      [event("llm.calling", { runtimeId: "b" })],
      { state: "running", turnId: "attempt" },
    );
    const projected = projectExecutionTurns([], raw).latestTurn;
    expect(projected?.sourceCommitted).toBe(true);
    expect(projected?.steps.map((row) => [row.runtimeId, row.status])).toEqual([
      ["b", "running"],
      ["c", "failed"],
    ]);
  });

  it("retains an empty authoritative terminal failure list", () => {
    const raw = reconcileExecutionSteps(
      [],
      [
        event("turn.completed", {
          committed: true,
          sourceFailedRuntimeIds: [],
        }),
      ],
      { state: "completed", turnId: "attempt" },
    );
    expect(raw[0].sourceFailedRuntimeIds).toEqual([]);
    expect(projectExecutionTurns([], raw).latestTurn?.steps).toEqual([]);
  });
});
