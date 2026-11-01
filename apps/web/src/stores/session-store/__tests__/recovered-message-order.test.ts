// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer.js";
import type { StreamMessage } from "../types.js";

const row = (
  id: string,
  role: StreamMessage["role"],
  kind: StreamMessage["kind"],
  turnId: string,
  timestamp: string,
): StreamMessage => ({ id, role, kind, turnId, content: id, timestamp });

describe("reload hydration order", () => {
  it("keeps the player message first when a plugin surface hydrated before the snapshot", () => {
    // Plugin-data hydration synthesises the guide surface before the server
    // snapshot arrives, so it is the only row when the snapshot merges.
    const surface = row(
      "plugin-message:guide:turn-2",
      "assistant",
      "plugin-message",
      "turn-2",
      "2026-10-02T05:00:00.000Z",
    );
    const snapshot = [
      row("u1", "user", undefined, "turn-1", "2026-10-02T04:50:00.000Z"),
      row("s1", "assistant", "story", "turn-1", "2026-10-02T04:51:00.000Z"),
      row("u2", "user", undefined, "turn-2", "2026-10-02T04:54:59.000Z"),
      row("s2", "assistant", "story", "turn-2", "2026-10-02T04:56:35.000Z"),
      row("c2", "assistant", undefined, "turn-2", "2026-10-02T04:56:40.000Z"),
    ];

    const state = reducer(
      { ...initialState, messages: [surface] },
      { type: "MERGE_RECOVERED_MESSAGES", messages: snapshot },
    );

    expect(state.messages.map((m) => m.id)).toEqual([
      "u1",
      "s1",
      "u2",
      "s2",
      "plugin-message:guide:turn-2",
      "c2",
    ]);
  });
});

it("recovers a missing marker without losing live text, loaded pages, segments or actions", () => {
  const story: StreamMessage = {
    ...row("story", "assistant", "story", "turn", "now"),
    content: "Live text.",
    segments: [{ kind: "narration", text: "Live text." }],
  };
  const old = row("older-page", "user", undefined, "old-turn", "before");
  const recovered = {
    ...story,
    content: "Older response text.",
    operationFailures: { count: 1 },
  };
  const state = reducer(
    {
      ...initialState,
      olderMessagesCursor: "page-anchor",
      messages: [old, story],
    },
    { type: "MERGE_RECOVERED_MESSAGES", messages: [recovered] },
  );
  expect(state.messages).toEqual([
    old,
    { ...story, operationFailures: { count: 1 } },
  ]);
  expect(state.olderMessagesCursor).toBe("page-anchor");
  const stale = reducer(state, {
    type: "MERGE_RECOVERED_MESSAGES",
    messages: [story],
  });
  expect(stale.messages).toEqual(state.messages);
  const reset = reducer(stale, { type: "RESET_SESSION" });
  expect(reset.messages).toEqual([]);
});

it("replaces a closed stream with its durable annotated row after losing the notice event", () => {
  const story = {
    ...row("saved", "assistant", "story", "turn", "now"),
    runtimeId: "teller",
    operationFailures: { count: 1 },
  };
  const state = reducer(
    {
      ...initialState,
      messages: [
        {
          ...story,
          id: "stream_turn_teller",
          content: "",
          operationFailures: undefined,
        },
      ],
    },
    { type: "MERGE_RECOVERED_MESSAGES", messages: [story] },
  );
  expect(state.messages).toEqual([story]);
});

it("fills a missing notice on a page overlap while retaining the loaded window and cursor", () => {
  const story = row("story", "assistant", "story", "turn", "now");
  const result = reducer(
    { ...initialState, messages: [story] },
    {
      type: "PREPEND_MESSAGES",
      messages: [
        {
          ...story,
          content: "Stale response text",
          operationFailures: { count: 2 },
        },
      ],
      cursor: "next-page",
    },
  );
  expect(result.messages).toEqual([
    { ...story, operationFailures: { count: 2 } },
  ]);
  expect(result.olderMessagesCursor).toBe("next-page");
});
