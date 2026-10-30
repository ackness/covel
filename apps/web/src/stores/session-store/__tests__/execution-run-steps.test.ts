// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer.js";
import {
  createExecutionStepUpdate,
  findExecutionStepIndex,
} from "../execution-steps.js";
import { projectExecutionTurns } from "../execution-projection.js";
import type { ExecutionStep } from "../types.js";

const step = (
  runId?: string,
  status: ExecutionStep["status"] = "running",
  startedAt = "2026-10-01T00:00:00Z",
): ExecutionStep => ({
  turnId: "turn",
  runtimeId: "runtime",
  pluginId: "plugin",
  runId,
  status,
  startedAt,
});
const upsert = (state: typeof initialState, row: ExecutionStep) =>
  reducer(state, { type: "UPSERT_EXECUTION_STEP", step: row });

describe("execution rows for nested runtime runs", () => {
  it("settles each run independently", () => {
    let state = upsert(initialState, step("a"));
    state = upsert(state, step("b", "running", "2026-10-01T00:00:01Z"));
    expect(state.executionSteps).toHaveLength(2);
    state = upsert(state, { ...step("b", "completed"), startedAt: undefined });
    expect(
      state.executionSteps.map(({ runId, status }) => ({ runId, status })),
    ).toEqual([
      { runId: "a", status: "running" },
      { runId: "b", status: "completed" },
    ]);
    state = upsert(state, step("a", "failed"));
    expect(
      state.executionSteps.map(({ runId, status }) => ({ runId, status })),
    ).toEqual([
      { runId: "a", status: "failed" },
      { runId: "b", status: "completed" },
    ]);
  });

  it("updates the newest run when an incoming step has no run id", () => {
    let state = upsert(initialState, step("a"));
    state = upsert(state, step("b", "running", "2026-10-01T00:00:01Z"));
    const { runId: _runId, ...update } = step(undefined, "completed");
    state = upsert(state, update);
    expect(state.executionSteps).toHaveLength(2);
    expect(state.executionSteps[0]).toMatchObject({
      runId: "a",
      status: "running",
    });
    expect(state.executionSteps[1]).toMatchObject({
      runId: "b",
      status: "completed",
    });
  });

  it("adopts a placeholder when the run id arrives", () => {
    let state = upsert(initialState, step());
    state = upsert(state, step("a"));
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0]?.runId).toBe("a");
    expect(
      findExecutionStepIndex(
        [step("a"), step(), step(undefined, "running", "2026-10-01T00:00:01Z")],
        step("b"),
      ),
    ).toBe(2);
  });

  it("appends reasoning to the newest run", () => {
    let state = upsert(initialState, step("a"));
    state = upsert(state, step("b", "running", "2026-10-01T00:00:01Z"));
    state = reducer(state, {
      type: "APPEND_REASONING",
      turnId: "turn",
      runtimeId: "runtime",
      pluginId: "plugin",
      entry: {
        id: "reason",
        content: "Thinking",
        timestamp: "2026-10-01T00:00:02Z",
      },
    });
    expect(state.executionSteps[0]?.reasoning).toBeUndefined();
    expect(state.executionSteps[1]?.reasoning).toHaveLength(1);
  });

  it.each<ExecutionStep["status"]>([
    "failed",
    "running",
    "llm",
    "tool",
    "suspended",
    "deferred",
    "unknown",
    "completed",
  ])("keeps a %s run visible over a completed or skipped twin", (status) => {
    const { turns } = projectExecutionTurns(
      [],
      [
        step("a", status),
        step(
          "b",
          status === "completed" ? "skipped" : "completed",
          "2026-10-01T00:00:01Z",
        ),
      ],
    );
    expect(turns[0]?.steps).toHaveLength(1);
    expect(turns[0]?.steps[0]?.status).toBe(status);
  });

  it("uses the later run for equal priority, and later legacy rows regardless of status", () => {
    expect(
      projectExecutionTurns(
        [],
        [step("a"), step("b", "running", "2026-10-01T00:00:01Z")],
      ).turns[0]?.steps[0]?.runId,
    ).toBe("b");
    expect(
      projectExecutionTurns(
        [],
        [
          step(undefined, "failed"),
          step(undefined, "completed", "2026-10-01T00:00:01Z"),
        ],
      ).turns[0]?.steps[0]?.status,
    ).toBe("completed");
  });

  it.each(["completed", "failed", "skipped"] as const)(
    "keeps a terminal %s run id and ignores empty or invalid ids",
    (status) => {
      expect(
        createExecutionStepUpdate({
          payload: { runtimeId: "runtime", runId: "b" },
          turnId: "turn",
          status,
        }).runId,
      ).toBe("b");
      for (const runId of ["", 2, undefined])
        expect(
          createExecutionStepUpdate({
            payload: { runId },
            turnId: "turn",
            status,
          }).runId,
        ).toBeUndefined();
    },
  );
});
