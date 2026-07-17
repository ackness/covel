/**
 * Live-append message window cap (`ui.chatMessageWindow`).
 *
 * A marathon tab must not grow `messages` without bound: once a live append
 * exceeds the configured cap, the OLDEST rows are dropped and
 * `olderMessagesCursor` advances to the new window edge, so the existing
 * scroll-up path re-fetches exactly the dropped range (no unreachable gap).
 * Streaming placeholders are never dropped, and PREPEND_MESSAGES (the user
 * explicitly loading history) never caps.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  configureMessagesWindowCap,
  initialState,
  reducer,
} from "../session-store/reducer.js";
import type { SessionState, StreamMessage } from "../session-store/types.js";

const CAP_MIN = 200;

function msg(i: number, over?: Partial<StreamMessage>): StreamMessage {
  return {
    id: `m-${String(i).padStart(4, "0")}`,
    role: "assistant",
    content: `msg ${i}`,
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
    ...over,
  };
}

function stateWith(messages: StreamMessage[]): SessionState {
  return { ...initialState, messages };
}

function addMessage(state: SessionState, message: StreamMessage): SessionState {
  return reducer(state, { type: "ADD_MESSAGE", message });
}

afterEach(() => {
  // Restore the default so this file cannot leak a tiny cap into other tests.
  configureMessagesWindowCap(Number.NaN);
});

describe("live message window cap", () => {
  it("drops the oldest rows past the cap and advances the scroll-up cursor", () => {
    configureMessagesWindowCap(CAP_MIN);
    const full = stateWith(Array.from({ length: CAP_MIN }, (_, i) => msg(i)));

    const next = addMessage(full, msg(CAP_MIN));

    expect(next.messages).toHaveLength(CAP_MIN);
    expect(next.messages[0]!.id).toBe(msg(1).id);
    expect(next.messages.at(-1)!.id).toBe(msg(CAP_MIN).id);
    // Cursor points at the new window edge so scroll-up re-fetches the
    // dropped row (listMessagesPage fetches strictly BEFORE the cursor).
    expect(next.olderMessagesCursor).toEqual({
      createdAt: msg(1).timestamp,
      id: msg(1).id,
    });
  });

  it("does not cap below the cap and keeps the cursor untouched", () => {
    configureMessagesWindowCap(CAP_MIN);
    const small = stateWith([msg(0)]);
    const next = addMessage(small, msg(1));
    expect(next.messages).toHaveLength(2);
    expect(next.olderMessagesCursor).toBeNull();
  });

  it("skips capping when a streaming placeholder would be dropped", () => {
    configureMessagesWindowCap(CAP_MIN);
    const withPlaceholder = stateWith([
      msg(0, { id: "stream_t1_narrator" }),
      ...Array.from({ length: CAP_MIN - 1 }, (_, i) => msg(i + 1)),
    ]);
    const next = addMessage(withPlaceholder, msg(CAP_MIN));
    expect(next.messages).toHaveLength(CAP_MIN + 1);
    expect(next.messages[0]!.id).toBe("stream_t1_narrator");
  });

  it("PREPEND_MESSAGES never caps (explicit history load)", () => {
    configureMessagesWindowCap(CAP_MIN);
    const full = stateWith(
      Array.from({ length: CAP_MIN }, (_, i) => msg(i + 100)),
    );
    const older = Array.from({ length: 50 }, (_, i) => msg(i));
    const next = reducer(full, {
      type: "PREPEND_MESSAGES",
      messages: older,
      cursor: null,
    });
    expect(next.messages).toHaveLength(CAP_MIN + 50);
    expect(next.messages[0]!.id).toBe(msg(0).id);
  });

  it("configureMessagesWindowCap falls back to the default on invalid input", () => {
    configureMessagesWindowCap(1); // below MESSAGES_WINDOW_MIN → default (2000)
    const full = stateWith(Array.from({ length: 300 }, (_, i) => msg(i)));
    const next = addMessage(full, msg(300));
    expect(next.messages).toHaveLength(301);
  });
});
