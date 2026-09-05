import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";
import type { StreamMessage } from "../session-store/types.js";

function story(
  id: string,
  turnId = "turn-1",
  timestamp = "2026-09-05T00:00:00.000Z",
): StreamMessage {
  return {
    id,
    turnId,
    timestamp,
    role: "assistant",
    kind: "story",
    runtimeId: "narrator",
    content: `Full story ${id}`,
  };
}
function merge(
  messages: StreamMessage[],
  recovered: StreamMessage[],
  executing = false,
) {
  return reducer(
    { ...initialState, messages, executing },
    { type: "MERGE_RECOVERED_MESSAGES", messages: recovered },
  ).messages;
}

describe("reconnect message recovery", () => {
  it("restores the missing story before an already hydrated guide", () => {
    const guide = {
      ...story("plugin-message:guide:turn-1"),
      kind: "plugin-message",
      content: "",
    };
    const next = merge([guide], [story("committed-story")]);
    expect(next.map((message) => message.id)).toEqual([
      "committed-story",
      guide.id,
    ]);
    expect(next[0].content).toBe("Full story committed-story");
  });

  it("retains older loaded history, fresh live messages and the pagination cursor", () => {
    const old = story("old", "turn-0", "2026-09-04T00:00:00.000Z");
    const pending: StreamMessage = {
      id: "pending-user",
      role: "user",
      content: "Go on",
      timestamp: "2020-01-01T00:00:00.000Z",
    };
    const stream = {
      ...story("stream_turn-2_narrator", "turn-2", "2020-01-01T00:00:00.000Z"),
      content: "Live partial",
    };
    const state = {
      ...initialState,
      messages: [old, pending, stream],
      executing: true,
      olderMessagesCursor: "keep-cursor",
    };
    const next = reducer(state, {
      type: "MERGE_RECOVERED_MESSAGES",
      messages: [old, story("missing")],
    });
    expect(next.messages.map((message) => message.id)).toEqual([
      "old",
      "missing",
      "pending-user",
      stream.id,
    ]);
    expect(next.messages.at(-1)).toBe(stream);
    expect(next.olderMessagesCursor).toBe("keep-cursor");
    expect(state.messages).toEqual([old, pending, stream]);
  });

  it("does not overwrite a newer completion or an active stream with a stale snapshot", () => {
    const live = { ...story("completed"), content: "New live completion" };
    const stream = {
      ...story("stream_turn-2_narrator", "turn-2"),
      content: "Still streaming",
    };
    const recovered = [story("completed"), story("server-turn-2", "turn-2")];
    const next = merge([live, stream], recovered, true);
    expect(next).toEqual([live, stream]);
    expect(merge(next, recovered, true)).toEqual(next);
  });

  it("recovers a closed stream from its authoritative committed message", () => {
    const stream = { ...story("stream_turn-1_narrator"), content: "Partial" };
    const full = story("committed");
    const next = merge([stream], [full]);
    expect(next).toEqual([full]);
    expect(merge(next, [full])).toEqual(next);
  });

  it("fills gaps using shared server IDs without reordering live rows by client clocks", () => {
    const a = story("a", "turn-a");
    const d = story("d", "turn-d");
    const live = story(
      "stream_turn-e_narrator",
      "turn-e",
      "2010-01-01T00:00:00.000Z",
    );
    const next = merge(
      [a, d, live],
      [a, story("b", "turn-b"), story("c", "turn-c"), d],
      true,
    );
    expect(next.map((message) => message.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      live.id,
    ]);
  });
});
