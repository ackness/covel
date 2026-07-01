import { describe, expect, it } from "vitest";
import type * as api from "@/services/api.js";
import { validateDebugSearch } from "../../debug.js";
import {
  getStoryTurnCount,
  getVisibleTurns,
  mergeTurnPages,
  traceEventMatchesCategory,
} from "../-debug-page-model.js";

function traceEvent(
  type: string,
  payload: Record<string, unknown> = {},
): api.TraceEvent {
  return {
    type,
    requestId: "req",
    traceId: "trace",
    sessionId: "session",
    turnId: "turn",
    flowId: "flow",
    seq: 1,
    timestamp: "2026-05-11T00:00:00.000Z",
    payload,
  };
}

function turn(turnId: string, events: api.TraceEvent[]): api.TurnTrace {
  return {
    turnId,
    flowId: `flow-${turnId}`,
    traceId: `trace-${turnId}`,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:00:01.000Z",
    eventCount: events.length,
    events: events.map((event, index) => ({
      ...event,
      turnId,
      seq: index + 1,
    })),
  };
}

describe("debug route model", () => {
  it("keeps route search params limited to a string sid", () => {
    expect(validateDebugSearch({ sid: "session-1" })).toEqual({
      sid: "session-1",
    });
    expect(validateDebugSearch({ sid: 42 })).toEqual({ sid: undefined });
  });

  it("counts story turns while retaining manual invocation placement", () => {
    const storyA = turn("story-a", [traceEvent("turn.started")]);
    const manual = turn("manual", [
      traceEvent("turn.started", {
        manualTrigger: { runtimeId: "plugin/manual" },
      }),
    ]);
    const storyB = turn("story-b", [traceEvent("turn.started")]);

    expect(getStoryTurnCount([storyA, manual, storyB])).toBe(2);
    expect(
      getVisibleTurns([storyA, manual, storyB]).map((item) => item.turnIndex),
    ).toEqual([1, 1, 2]);
  });

  it("matches both outer trace event types and runtime progress inner types", () => {
    expect(
      traceEventMatchesCategory(traceEvent("state.patch.applied"), "state"),
    ).toBe(true);
    expect(
      traceEventMatchesCategory(
        traceEvent("runtime.progress", { type: "tool.calling" }),
        "tool",
      ),
    ).toBe(true);
    expect(
      traceEventMatchesCategory(traceEvent("message.completed"), "llm"),
    ).toBe(false);
  });
});

// 事件构造器：显式控制 seq / timestamp，用于验证按 turnId 合并的去重与重排。
function seqEvent(
  turnId: string,
  seq: number,
  timestamp: string,
): api.TraceEvent {
  return {
    type: "llm.responded",
    requestId: `req-${seq}`,
    traceId: `trace-${turnId}`,
    sessionId: "session",
    turnId,
    flowId: `flow-${turnId}`,
    seq,
    timestamp,
    payload: {},
  };
}

function pagedTurn(
  turnId: string,
  startedAt: string,
  completedAt: string,
  events: api.TraceEvent[],
): api.TurnTrace {
  return {
    turnId,
    flowId: `flow-${turnId}`,
    traceId: `trace-${turnId}`,
    startedAt,
    completedAt,
    eventCount: events.length,
    events,
  };
}

describe("mergeTurnPages", () => {
  it("merges a boundary turn split across windows by turnId", () => {
    // 更旧一页只含边界 turn 的前半段事件，现有页含后半段。
    const older = pagedTurn("turn-1", "00:00", "00:02", [
      seqEvent("turn-1", 1, "00:00"),
      seqEvent("turn-1", 2, "00:02"),
    ]);
    const current = pagedTurn("turn-1", "00:03", "00:05", [
      seqEvent("turn-1", 3, "00:03"),
      seqEvent("turn-1", 4, "00:05"),
    ]);

    const merged = mergeTurnPages([current], [older]);

    expect(merged).toHaveLength(1);
    const [turn] = merged;
    // 事件合并去重、按 seq 重排、eventCount 重算。
    expect(turn.eventCount).toBe(4);
    expect(turn.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // startedAt 取更早、completedAt 取更晚。
    expect(turn.startedAt).toBe("00:00");
    expect(turn.completedAt).toBe("00:05");
  });

  it("dedupes identical events when re-pulling the latest window", () => {
    const first = pagedTurn("turn-9", "10:00", "10:01", [
      seqEvent("turn-9", 1, "10:00"),
      seqEvent("turn-9", 2, "10:01"),
    ]);
    // 自动刷新重拉同一窗口：事件完全重复，加上一条新事件。
    const refreshed = pagedTurn("turn-9", "10:00", "10:02", [
      seqEvent("turn-9", 1, "10:00"),
      seqEvent("turn-9", 2, "10:01"),
      seqEvent("turn-9", 3, "10:02"),
    ]);

    const merged = mergeTurnPages([first], [refreshed]);

    expect(merged).toHaveLength(1);
    expect(merged[0].eventCount).toBe(3);
    expect(merged[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("orders merged turns by startedAt ascending and keeps distinct turns", () => {
    const older = pagedTurn("turn-a", "01:00", "01:01", [
      seqEvent("turn-a", 1, "01:00"),
    ]);
    const newer = pagedTurn("turn-b", "02:00", "02:01", [
      seqEvent("turn-b", 1, "02:00"),
    ]);

    // 现有页是较新的 turn-b，追加更旧一页 turn-a → 结果按 startedAt 正序。
    const merged = mergeTurnPages([newer], [older]);

    expect(merged.map((t) => t.turnId)).toEqual(["turn-a", "turn-b"]);
  });
});
