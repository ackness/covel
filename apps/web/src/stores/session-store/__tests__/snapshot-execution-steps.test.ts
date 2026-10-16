// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SnapshotTraceEvent } from "@covel/shared";
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
