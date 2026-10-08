// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDeferredExecutionStep,
  buildDurableRuntimeJobExecutionStep,
  buildJobStatusExecutionStep,
} from "../execution-steps.js";
import { initialState, reducer } from "../reducer.js";
import { reconcileExecutionSteps } from "../snapshot-execution-steps.js";
import type { ExecutionStep } from "../types.js";
import { projectExecutionTurns } from "../execution-projection.js";

function control(state = "succeeded", sequence = 4, jobId = "job") {
  return {
    runtimeId: "plugin/worker",
    pluginId: "plugin",
    jobId,
    progressScopeId: jobId,
    state,
    sequence,
    progress: state === "succeeded" ? 100 : 0,
    data: { durableStatus: state, originTurnId: "source" },
  };
}

function handoff(jobId = "job", startedAt?: string) {
  return buildDeferredExecutionStep(
    {
      runtimeId: "plugin/worker",
      pluginId: "plugin",
      jobId,
      sourceTurnId: "source",
    },
    undefined,
    startedAt,
  )!;
}

function reduceSteps(...steps: ExecutionStep[]) {
  return steps.reduce(
    (state, step) => reducer(state, { type: "UPSERT_EXECUTION_STEP", step }),
    initialState,
  ).executionSteps;
}

describe("background job projection ordering", () => {
  it.each(["succeeded", "failed"])(
    "attaches recovered background reasoning to its %s source job in either arrival order",
    (status) => {
      const events = [
        {
          type: "gateway.responded",
          turnId: "background",
          timestamp: "2026-10-08T00:00:02Z",
          payload: {
            runtimeId: "plugin/worker",
            pluginId: "plugin",
            reasoningContent: "Extract the new clue.",
            seq: 1,
          },
        },
      ];
      const recovery = {
        type: "REPLACE_PLUGIN_DATA_FOR_PLUGIN" as const,
        pluginId: "plugin",
        namespaces: {
          _runtime_jobs: {
            job: {
              runtimeId: "plugin/worker",
              status,
              origin: { sourceTurnId: "source" },
              backgroundTurnId: "background",
              ...(status === "failed"
                ? { error: "Runtime job execution failed." }
                : {}),
            },
          },
        },
      };
      for (const jobsFirst of [true, false]) {
        let state = jobsFirst ? reducer(initialState, recovery) : initialState;
        state = reducer(state, {
          type: "LOAD_EXECUTION_STEPS",
          steps: reconcileExecutionSteps(state.executionSteps, events, {
            state: "idle",
          }),
        });
        if (!jobsFirst) state = reducer(state, recovery);
        // Repeated snapshot recovery must not recreate the orphan or duplicate reasoning.
        state = reducer(state, {
          type: "LOAD_EXECUTION_STEPS",
          steps: reconcileExecutionSteps(state.executionSteps, events, {
            state: "idle",
          }),
        });
        expect(state.executionSteps).toHaveLength(1);
        expect(state.executionSteps[0]).toMatchObject({
          turnId: "source",
          status: status === "succeeded" ? "completed" : "failed",
          detached: true,
          reasoning: [
            expect.objectContaining({ content: "Extract the new clue." }),
          ],
        });
        expect(state.executionSteps[0]?.detail).toBe(
          status === "failed" ? "Runtime job execution failed." : undefined,
        );
        expect(
          projectExecutionTurns([], state.executionSteps).turns.map(
            (turn) => turn.turnId,
          ),
        ).toEqual(["source"]);
      }
    },
  );
  it("merges stale and advancing durable recovery without losing the live sequence", () => {
    let state = reducer(initialState, {
      type: "UPSERT_EXECUTION_STEP",
      step: buildJobStatusExecutionStep(control("running", 2), undefined)!,
    });
    const recover = (status: string) => {
      state = reducer(state, {
        type: "REPLACE_PLUGIN_DATA_FOR_PLUGIN",
        pluginId: "plugin",
        namespaces: {
          _runtime_jobs: {
            job: {
              runtimeId: "plugin/worker",
              status,
              origin: { sourceTurnId: "source" },
            },
          },
        },
      });
      return state.executionSteps[0]!;
    };
    expect(recover("queued")).toMatchObject({
      jobState: "running",
      durableJobStatus: { state: "running", sequence: 2 },
    });
    expect(recover("running").durableJobStatus?.sequence).toBe(2);
    state = reducer(state, {
      type: "UPSERT_EXECUTION_STEP",
      step: buildJobStatusExecutionStep(control("queued", 0), undefined)!,
    });
    expect(state.executionSteps[0]!.jobState).toBe("running");
    expect(recover("committing")).toMatchObject({
      jobState: "committing",
      durableJobStatus: { sequence: 2 },
    });
    state = reducer(state, {
      type: "UPSERT_EXECUTION_STEP",
      step: buildJobStatusExecutionStep(control("running", 3), undefined)!,
    });
    expect(state.executionSteps[0]!.jobState).toBe("committing");
    expect(recover("succeeded")).toMatchObject({
      status: "completed",
      durableJobStatus: { state: "succeeded", sequence: 2 },
    });
    expect(recover("queued").jobState).toBe("succeeded");
  });

  it("keeps control events observed after recovery captured its input rows", () => {
    const terminal = buildJobStatusExecutionStep(control(), undefined)!;
    const state = reducer(initialState, {
      type: "UPSERT_EXECUTION_STEP",
      step: terminal,
    });
    expect(
      reducer(state, { type: "LOAD_EXECUTION_STEPS", steps: [handoff()] })
        .executionSteps[0],
    ).toEqual(state.executionSteps[0]);
    expect(
      reducer(state, { type: "LOAD_EXECUTION_STEPS", steps: [] })
        .executionSteps[0],
    ).toEqual(state.executionSteps[0]);
  });
  it.each([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "stale",
    "orphaned",
  ])(
    "keeps durable %s after delayed queued status, handoff and sub-job progress",
    (state) => {
      const terminal = buildJobStatusExecutionStep(control(state), undefined)!;
      const queued = buildJobStatusExecutionStep(
        control("queued", 0),
        undefined,
      )!;
      const child = buildJobStatusExecutionStep(
        {
          ...control("progress", 999, "child"),
          progressScopeId: "worker-execution",
          data: { runtimeJobId: "job", originTurnId: "source" },
        },
        undefined,
      )!;
      expect(reduceSteps(terminal, queued, handoff(), child)[0]).toEqual(
        terminal,
      );
    },
  );

  it("keeps the newest control sequence before completion and does not compare child sequences", () => {
    const running = buildJobStatusExecutionStep(
      control("running", 2),
      undefined,
    )!;
    const child = buildJobStatusExecutionStep(
      {
        ...control("progress", 999, "child"),
        progress: 60,
        data: { runtimeJobId: "job", originTurnId: "source" },
      },
      undefined,
    )!;
    const completed = buildJobStatusExecutionStep(control(), undefined)!;
    expect(
      reduceSteps(
        running,
        handoff(),
        buildJobStatusExecutionStep(control("queued", 0), undefined)!,
      )[0],
    ).toEqual(running);
    expect(reduceSteps(running, child, completed)[0]).toMatchObject({
      status: "completed",
      jobState: "succeeded",
      progress: 100,
      durableJobStatus: { sequence: 4 },
    });
  });

  it("keeps the handoff's start time in either arrival order and through later control events", () => {
    const startedAt = "2026-10-05T00:00:01.000Z";
    const announced = handoff("job", startedAt);
    // Built without the existing row, as in a batch that has not refreshed stateRef.
    const queued = buildJobStatusExecutionStep(
      control("queued", 0),
      undefined,
    )!;
    const running = buildJobStatusExecutionStep(
      control("running", 2),
      undefined,
    )!;
    for (const arrival of [
      [queued, announced],
      [announced, queued],
    ]) {
      expect(reduceSteps(...arrival, running)[0]).toMatchObject({
        jobState: "running",
        startedAt,
      });
    }
    const retry = buildJobStatusExecutionStep(
      control("queued", 0, "retry"),
      undefined,
    )!;
    expect(reduceSteps(announced, retry)[0]!.startedAt).toBeUndefined();
  });

  it("starts a different job without inheriting the previous terminal or sequence", () => {
    const completed = buildJobStatusExecutionStep(control(), undefined)!;
    const next = reduceSteps(completed, handoff("retry"))[0]!;
    expect(next).toMatchObject({
      jobId: "retry",
      status: "deferred",
      jobState: "queued",
    });
    expect(next.durableJobStatus).toBeUndefined();
    expect(next.progress).toBeUndefined();
    expect(
      reduceSteps(
        completed,
        handoff("retry"),
        buildJobStatusExecutionStep(control("running", 1, "retry"), undefined)!,
      )[0],
    ).toMatchObject({
      jobId: "retry",
      jobState: "running",
      durableJobStatus: { sequence: 1 },
    });
  });

  it("accepts a plugin's finalizer failure after its earlier reported success", () => {
    const progress = { ...control(), data: { originTurnId: "source" } };
    const success = buildJobStatusExecutionStep(progress, undefined)!;
    const failed = buildJobStatusExecutionStep(
      {
        ...progress,
        state: "failed",
        sequence: 5,
        message: "Writes did not commit",
      },
      undefined,
    )!;
    expect(reduceSteps(success, failed)[0]).toMatchObject({
      status: "failed",
      detail: "Writes did not commit",
    });
  });

  it("does not treat a plugin's business durableStatus field as parent control", () => {
    const payload = {
      ...control("succeeded", 999, "child"),
      progressScopeId: "worker-execution",
      data: {
        runtimeJobId: "job",
        originTurnId: "source",
        durableStatus: "succeeded",
      },
    };
    const child = buildJobStatusExecutionStep(payload, undefined)!;
    expect(child.durableJobStatus).toBeUndefined();
    expect(child.status).toBe("deferred");
  });

  it("protects a durable terminal restored without a status sequence", () => {
    const restored = buildDurableRuntimeJobExecutionStep("plugin", "job", {
      runtimeId: "plugin/worker",
      status: "succeeded",
      origin: { sourceTurnId: "source" },
    })!;
    expect(
      reduceSteps(
        restored,
        handoff(),
        buildJobStatusExecutionStep(control("queued", 0), undefined)!,
      )[0],
    ).toEqual(restored);
    const recovered = reconcileExecutionSteps(
      [restored],
      [
        {
          type: "runtime.deferred",
          turnId: "source",
          timestamp: "2026-10-05T00:00:00Z",
          payload: {
            runtimeId: "plugin/worker",
            pluginId: "plugin",
            jobId: "job",
            sourceTurnId: "source",
          },
        },
      ],
    );
    expect(recovered[0]).toMatchObject({
      status: "completed",
      jobState: "succeeded",
    });
  });
});
