import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionExecutionStatus } from "@covel/shared";
import type * as api from "@/services/api.js";
import { getTurnRuntimes, isTurnInterrupted } from "../-execution-status.js";
import { TraceTimeline } from "../-trace-timeline.js";

afterEach(cleanup);

function trace(): api.TurnTrace {
  const events = [
    { type: "turn.started", payload: {} },
    { type: "runtime.completed", payload: { runtimeId: "setup" } },
    {
      type: "runtime.failed",
      payload: { runtimeId: "side-task", error: "Failed" },
    },
    { type: "runtime.started", payload: { runtimeId: "narrator" } },
  ].map((event, seq) => ({
    ...event,
    requestId: "request-a",
    traceId: "trace-a",
    sessionId: "session-a",
    turnId: "turn-a",
    flowId: "flow-a",
    seq,
    timestamp: `2026-09-05T00:00:0${seq}.000Z`,
  }));
  return {
    turnId: "turn-a",
    flowId: "flow-a",
    traceId: "trace-a",
    startedAt: events[0]!.timestamp,
    completedAt: "",
    eventCount: events.length,
    events,
  };
}

const interrupted: SessionExecutionStatus = {
  state: "interrupted",
  turnId: "turn-a",
  requestId: "request-a",
};

describe("debugger interrupted execution", () => {
  it("settles only unfinished runtimes without changing the source trace or inventing timestamps", () => {
    const turn = trace();
    const original = structuredClone(turn);
    expect(isTurnInterrupted(turn, interrupted)).toBe(true);
    const runtimes = getTurnRuntimes(turn, interrupted);
    expect(
      runtimes.map(({ runtimeId, status }) => [runtimeId, status]),
    ).toEqual([
      ["setup", "completed"],
      ["side-task", "failed"],
      ["narrator", "interrupted"],
    ]);
    expect(runtimes[2]?.completedAt).toBeUndefined();
    expect(turn).toEqual(original);
  });

  it.each<SessionExecutionStatus | undefined>([
    undefined,
    { state: "idle" },
    { state: "running", turnId: "turn-a" },
    { state: "interrupted", turnId: "turn-other" },
    { state: "interrupted" },
  ])(
    "does not infer interruption from missing events or an unrelated status: %j",
    (execution) => {
      expect(isTurnInterrupted(trace(), execution)).toBe(false);
      expect(getTurnRuntimes(trace(), execution)[2]?.status).toBe("running");
    },
  );

  it.each(["turn.completed", "flow.completed", "turn.failed", "flow.failed"])(
    "keeps a terminal %s event authoritative over stale execution status",
    (type) => {
      const turn = trace();
      turn.events.push({ ...turn.events[0]!, type, seq: 5 });
      expect(isTurnInterrupted(turn, interrupted)).toBe(false);
    },
  );

  it("shows an interruption summary and stops unfinished task animations while retaining event details", () => {
    const turn = trace();
    const { container } = render(
      <TraceTimeline
        selectedSessionId="session-a"
        turns={[{ turn, turnIndex: 1 }]}
        execution={interrupted}
        loading={false}
        expandedTurns={new Set([turn.turnId])}
        expandedRuntimes={new Set(["turn-a:narrator"])}
        filterCategory={null}
        onToggleTurn={vi.fn()}
        onToggleRuntime={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/^(已中断|Interrupted)$/)).toHaveLength(2);
    expect(screen.queryByText("运行中")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByText("runtime.started")).toBeDefined();
    expect(screen.queryByText("turn.completed")).toBeNull();
  });
});
