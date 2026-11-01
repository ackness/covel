// @vitest-environment node
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
  it("replaces player echoes once without collapsing repeated inputs across or within turns", () => {
    const user = (id: string, turnId = "turn-1"): StreamMessage => ({
      id,
      turnId,
      role: "user",
      content: "Go on",
      timestamp: "2026-09-18T00:00:00Z",
    });
    const old = user("old", "turn-0");
    const recovered = [user("server-1"), user("server-2"), story("reply")];
    const current = [old, user("echo-1"), user("echo-2"), story("reply")];
    const next = merge(current, recovered);
    expect(next.map((row) => row.id)).toEqual([
      "old",
      "server-1",
      "server-2",
      "reply",
    ]);
    expect(merge(next, recovered)).toBe(next);
    expect(current[1]!.id).toBe("echo-1");
  });
  it("fills the actions of a player message that is already shown without them", () => {
    const answer: StreamMessage = {
      id: "answer",
      turnId: "turn-1",
      role: "user",
      content: "Ready",
      timestamp: "2026-09-18T00:00:00Z",
    };
    const actions = [
      { kind: "act", seatId: "main", actorId: "bo", source: "player" },
    ] as unknown as StreamMessage["actions"];
    const next = merge([answer], [{ ...answer, actions }]);
    expect(next).toEqual([{ ...answer, actions }]);
    // Actions already on the row stay as they are.
    expect(merge(next, [{ ...answer, actions: [] }])).toBe(next);
  });
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
    expect(next[0]!.content).toBe("Full story committed-story");
  });

  it("retains older loaded history, fresh committed messages and the pagination cursor", () => {
    const old = story("old", "turn-0", "2026-09-04T00:00:00.000Z");
    const pending: StreamMessage = {
      id: "pending-user",
      role: "user",
      content: "Go on",
      timestamp: "2020-01-01T00:00:00.000Z",
    };
    const stream = {
      ...story("next-committed", "turn-2", "2020-01-01T00:00:00.000Z"),
      content: "Full next story",
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

  it("retains a newer completion and adds distinct durable rows from the same runtime", () => {
    const live = { ...story("completed"), content: "New completion" };
    const other = story("other", "turn-2");
    const recovered = [story("completed"), other];
    const next = merge([live], recovered, true);
    expect(next).toEqual([live, other]);
    expect(merge(next, recovered, true)).toBe(next);
  });

  it("fills gaps using shared server IDs without reordering live rows by client clocks", () => {
    const a = story("a", "turn-a");
    const d = story("d", "turn-d");
    const live = story("newest", "turn-e", "2010-01-01T00:00:00.000Z");
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

it("keeps the entire state when a snapshot adds no messages or drafts", () => {
  const state = { ...initialState, messages: [story("saved")] };
  expect(
    reducer(state, {
      type: "MERGE_RECOVERED_MESSAGES",
      messages: [story("saved")],
    }),
  ).toBe(state);
});
