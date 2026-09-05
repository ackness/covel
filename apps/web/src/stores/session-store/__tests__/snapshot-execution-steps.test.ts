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
