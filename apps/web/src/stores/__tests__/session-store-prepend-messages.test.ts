/**
 * Regression tests for the PREPEND_MESSAGES / SET_OLDER_MESSAGES_CURSOR slice
 * of the session-store reducer (backward "load older" cursor pagination).
 *
 * Unlike the assets / suspensions slice tests (which re-implement the slice as
 * a pure mirror), these exercise the REAL production `reducer` + `initialState`
 * so any drift in the merge / dedup / ordering / cursor logic fails here.
 *
 * Invariants pinned:
 *   - older batch is merged to the FRONT (never LOAD_MESSAGES overwrite)
 *   - dedup by id (overlapping boundary rows are not duplicated)
 *   - result stays ordered by createdAt (StreamMessage.timestamp) ascending
 *   - olderMessagesCursor is advanced to the action's cursor (incl. null)
 *   - the previous messages array is never mutated (immutability)
 */

import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";
import type { StreamMessage } from "../session-store/types.js";

function msg(id: string, createdAt: string): StreamMessage {
  return {
    id,
    role: "assistant",
    content: `content-${id}`,
    timestamp: createdAt,
  };
}

describe("session-store — PREPEND_MESSAGES slice", () => {
  it("prepends older messages to the front and advances the cursor", () => {
    const state = {
      ...initialState,
      messages: [msg("c", "2026-01-03"), msg("d", "2026-01-04")],
      olderMessagesCursor: { createdAt: "2026-01-03", id: "c" },
    };
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01"), msg("b", "2026-01-02")],
      cursor: { createdAt: "2026-01-01", id: "a" },
    });
    expect(next.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(next.olderMessagesCursor).toEqual({
      createdAt: "2026-01-01",
      id: "a",
    });
  });

  it("dedupes by id when the older batch overlaps the boundary", () => {
    const state = {
      ...initialState,
      messages: [msg("b", "2026-01-02"), msg("c", "2026-01-03")],
      olderMessagesCursor: { createdAt: "2026-01-02", id: "b" },
    };
    // "b" is already present; only "a" is genuinely older.
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01"), msg("b", "2026-01-02")],
      cursor: null,
    });
    expect(next.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    // No duplicate "b".
    expect(next.messages.filter((m) => m.id === "b")).toHaveLength(1);
    expect(next.olderMessagesCursor).toBeNull();
  });

  it("prepends the older page in front, preserving order", () => {
    // `older` comes from listMessagesPage(before=oldest-loaded), so by contract
    // it is already ascending AND strictly older than everything in `messages`.
    // The reducer must NOT re-sort by timestamp (that would let a client
    // wall-clock stream placeholder reorder server history under clock skew) —
    // it just concatenates the older page in front.
    const state = {
      ...initialState,
      messages: [msg("d", "2026-01-04")],
      olderMessagesCursor: { createdAt: "2026-01-04", id: "d" },
    };
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01"), msg("c", "2026-01-03")],
      cursor: { createdAt: "2026-01-01", id: "a" },
    });
    expect(next.messages.map((m) => m.timestamp)).toEqual([
      "2026-01-01",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("does not reorder existing messages by timestamp (clock-skew safety)", () => {
    // A stream placeholder can carry a client wall-clock timestamp that is
    // EARLIER than older server history when the client clock lags. The reducer
    // must keep the placeholder where it is (end), not sort it before the
    // prepended older history.
    const state = {
      ...initialState,
      // Placeholder's client timestamp (2020) is absurdly behind the real
      // server createdAt of the older page (2026).
      messages: [msg("stream_x", "2020-01-01")],
      olderMessagesCursor: { createdAt: "2026-01-02", id: "b" },
    };
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01")],
      cursor: null,
    });
    // Older history stays in front; the skewed placeholder stays last.
    expect(next.messages.map((m) => m.id)).toEqual(["a", "stream_x"]);
  });

  it("only advances the cursor (no message churn) when every row is a dup", () => {
    const original = [msg("a", "2026-01-01"), msg("b", "2026-01-02")];
    const state = {
      ...initialState,
      messages: original,
      olderMessagesCursor: { createdAt: "2026-01-01", id: "a" },
    };
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01")],
      cursor: null,
    });
    // Same array reference preserved — nothing new to insert.
    expect(next.messages).toBe(original);
    expect(next.olderMessagesCursor).toBeNull();
  });

  it("never mutates the previous messages array (immutability)", () => {
    const original = [msg("c", "2026-01-03")];
    const state = {
      ...initialState,
      messages: original,
      olderMessagesCursor: { createdAt: "2026-01-03", id: "c" },
    };
    const next = reducer(state, {
      type: "PREPEND_MESSAGES",
      messages: [msg("a", "2026-01-01")],
      cursor: { createdAt: "2026-01-01", id: "a" },
    });
    expect(original).toHaveLength(1);
    expect(original.map((m) => m.id)).toEqual(["c"]);
    expect(next.messages).not.toBe(original);
    expect(next.messages).toHaveLength(2);
  });

  it("SET_OLDER_MESSAGES_CURSOR replaces the cursor without touching messages", () => {
    const original = [msg("a", "2026-01-01")];
    const state = { ...initialState, messages: original };
    const withCursor = reducer(state, {
      type: "SET_OLDER_MESSAGES_CURSOR",
      cursor: { createdAt: "2026-01-01", id: "a" },
    });
    expect(withCursor.olderMessagesCursor).toEqual({
      createdAt: "2026-01-01",
      id: "a",
    });
    expect(withCursor.messages).toBe(original);

    const cleared = reducer(withCursor, {
      type: "SET_OLDER_MESSAGES_CURSOR",
      cursor: null,
    });
    expect(cleared.olderMessagesCursor).toBeNull();
  });
});
