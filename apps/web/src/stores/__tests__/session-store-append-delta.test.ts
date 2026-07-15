/**
 * APPEND_DELTA reducer — streaming-message append behaviour (R-17).
 *
 * The reducer takes an O(1) last-element fast path (the streaming placeholder
 * is almost always the last message) and only falls back to the O(n) findIndex
 * scan when the placeholder is not at the tail. These tests pin both paths plus
 * the create-new-placeholder path so the optimisation can't drift.
 */

import { describe, it, expect } from "vitest";
import { reducer, initialState } from "../session-store/reducer.js";
import type { SessionState, StreamMessage } from "../session-store/types.js";

function msg(over: Partial<StreamMessage> & { id: string }): StreamMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function stateWith(messages: StreamMessage[]): SessionState {
  return { ...initialState, messages };
}

describe("APPEND_DELTA", () => {
  it("appends to the streaming placeholder when it is the last message (fast path)", () => {
    const streamId = "stream_turn-1_narrator";
    const before = stateWith([
      msg({ id: "u1", role: "user" }),
      msg({
        id: streamId,
        content: "Hello ",
        turnId: "turn-1",
        runtimeId: "narrator",
      }),
    ]);

    const after = reducer(before, {
      type: "APPEND_DELTA",
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "world",
    });

    expect(after.messages).toHaveLength(2);
    expect(after.messages[1].content).toBe("Hello world");
    expect(after.messages).not.toBe(before.messages); // new reference for re-render
    expect(after.messages[0]).toBe(before.messages[0]); // untouched entries shared
  });

  it("falls back to findIndex when the placeholder is not the last message", () => {
    const streamId = "stream_turn-1_narrator";
    const before = stateWith([
      msg({
        id: streamId,
        content: "Hi ",
        turnId: "turn-1",
        runtimeId: "narrator",
      }),
      msg({ id: "asset-1", kind: "plugin", turnId: "turn-1" }), // arrived after the stream started
    ]);

    const after = reducer(before, {
      type: "APPEND_DELTA",
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "there",
    });

    expect(after.messages[0].content).toBe("Hi there");
    expect(after.messages[1]).toBe(before.messages[1]);
  });

  it("creates a new placeholder carrying turnId/runtimeId/kind when none exists", () => {
    const before = stateWith([msg({ id: "u1", role: "user" })]);

    const after = reducer(before, {
      type: "APPEND_DELTA",
      turnId: "turn-2",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "First token",
    });

    expect(after.messages).toHaveLength(2);
    const created = after.messages[1];
    expect(created.id).toBe("stream_turn-2_narrator");
    expect(created.content).toBe("First token");
    expect(created.turnId).toBe("turn-2");
    expect(created.runtimeId).toBe("narrator");
    expect(created.kind).toBe("story");
  });

  it("keeps distinct placeholders per runtime and appends to the right one", () => {
    const before = stateWith([
      msg({
        id: "stream_turn-1_narrator",
        content: "N",
        turnId: "turn-1",
        runtimeId: "narrator",
      }),
      msg({
        id: "stream_turn-1_codex",
        content: "C",
        turnId: "turn-1",
        runtimeId: "codex",
      }),
    ]);

    // Target the non-tail narrator placeholder.
    const after = reducer(before, {
      type: "APPEND_DELTA",
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "1",
    });

    expect(after.messages[0].content).toBe("N1");
    expect(after.messages[1].content).toBe("C");
  });
});
