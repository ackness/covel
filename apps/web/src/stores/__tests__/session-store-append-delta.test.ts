/**
 * APPEND_DELTA reducer — streaming-buffer append behaviour.
 *
 * Streaming text lives OUTSIDE the `messages` array in a fine-grained external
 * store keyed by the placeholder id. A token delta is an O(1) map write; the
 * placeholder message is inserted into `messages` exactly ONCE (first delta)
 * and its reference stays stable for the rest of the stream, so the O(history)
 * chat grouping memo and autoscroll never rebuild per token. These tests pin
 * that invariant plus the completion merge.
 */

import { describe, it, expect } from "vitest";
import { mergeChatExportMessages } from "@/lib/chat-export.js";
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

function appendDelta(
  state: SessionState,
  turnId: string,
  runtimeId: string,
  delta: string,
): SessionState {
  return reducer(state, {
    type: "APPEND_DELTA",
    turnId,
    runtimeId,
    pluginId: runtimeId,
    delta,
  });
}

describe("APPEND_DELTA", () => {
  it("creates the placeholder once, with empty content, on the first delta", () => {
    const before = stateWith([msg({ id: "u1", role: "user" })]);

    const after = appendDelta(before, "turn-2", "narrator", "First token");

    expect(after.messages).toHaveLength(2);
    const created = after.messages[1];
    expect(created.id).toBe("stream_turn-2_narrator");
    // Live text lives in the external store — placeholder content stays empty.
    expect(created.content).toBe("");
    expect(created.turnId).toBe("turn-2");
    expect(created.runtimeId).toBe("narrator");
    expect(created.kind).toBe("story");
  });

  it("keeps the messages reference stable when the placeholder already exists", () => {
    const first = appendDelta(
      stateWith([msg({ id: "u1", role: "user" })]),
      "turn-1",
      "narrator",
      "Hello ",
    );
    const second = appendDelta(first, "turn-1", "narrator", "world");

    // The whole point: messages is NOT copied per token.
    expect(second.messages).toBe(first.messages);
    // Live text is owned by the fine-grained streaming-text store. Repeated
    // reducer actions are idempotent and do not wake the SessionState context.
    expect(second).toBe(first);
  });

  it("keeps distinct streaming buffers per runtime", () => {
    let state = appendDelta(stateWith([]), "turn-1", "narrator", "N");
    state = appendDelta(state, "turn-1", "codex", "C");
    state = appendDelta(state, "turn-1", "narrator", "1");

    // Two placeholders, both content-empty; text is overlaid at render time.
    expect(state.messages.map((m) => m.id)).toEqual([
      "stream_turn-1_narrator",
      "stream_turn-1_codex",
    ]);
    expect(state.messages.every((m) => m.content === "")).toBe(true);
  });

  it("COMPLETE_MESSAGE merges the final text and clears the buffer", () => {
    const streaming = appendDelta(
      stateWith([]),
      "turn-1",
      "narrator",
      "partial",
    );

    const completed = reducer(streaming, {
      type: "COMPLETE_MESSAGE",
      turnId: "turn-1",
      runtimeId: "narrator",
      message: msg({
        id: "final-id",
        content: "the full authoritative narrative",
        turnId: "turn-1",
        runtimeId: "narrator",
      }),
    });

    expect(completed.messages).toHaveLength(1);
    // Completion adopts the persisted server id so export/history reconciliation
    // cannot append the same narrative twice under two different ids.
    expect(completed.messages[0].id).toBe("final-id");
    expect(completed.messages[0].content).toBe(
      "the full authoritative narrative",
    );
    expect(
      mergeChatExportMessages(
        [
          {
            id: "final-id",
            role: "assistant",
            content: "the full authoritative narrative",
          },
        ],
        completed.messages,
      ),
    ).toHaveLength(1);
    expect(
      reducer(completed, {
        type: "COMPLETE_MESSAGE",
        turnId: "turn-1",
        runtimeId: "narrator",
        message: completed.messages[0],
      }).messages,
    ).toHaveLength(1);
  });

  it("DISCARD_TURN_STREAMS drops placeholders for the turn", () => {
    let state = appendDelta(stateWith([]), "turn-1", "narrator", "a");
    state = appendDelta(state, "turn-2", "narrator", "b");

    const discarded = reducer(state, {
      type: "DISCARD_TURN_STREAMS",
      turnId: "turn-1",
    });

    expect(discarded.messages.map((m) => m.id)).toEqual([
      "stream_turn-2_narrator",
    ]);
  });
});
