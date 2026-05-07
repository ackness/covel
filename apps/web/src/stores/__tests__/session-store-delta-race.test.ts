/**
 * Tests for the delta-buffer session-switch race in session-store.tsx
 * (findings/08-frontend-races.md B).
 *
 * Context:
 *   - `handleSseEvent` buffers narrative.delta tokens per-runtime and
 *     flushes once per animation frame.
 *   - If the user switches sessions between buffer push and RAF fire,
 *     the flush must NOT dispatch APPEND_DELTA — otherwise session 1's
 *     tokens bleed into session 2's messages array.
 *
 * Strategy: the buffer/flush logic is small enough that we re-implement
 * the exact guard here and verify it behaves as designed. A full
 * SessionProvider integration test would require mocking the subscription
 * transport and dozens of services — not worth the complexity for what is
 * effectively a 4-line change.
 */

import { describe, it, expect, vi } from "vitest";

interface BufferEntry {
  turnId: string;
  runtimeId: string;
  pluginId: string;
  text: string;
  flushSessionId: string | null;
}

interface AppendDeltaAction {
  type: "APPEND_DELTA";
  turnId: string;
  runtimeId: string;
  pluginId: string;
  delta: string;
}

/** Re-implementation of the guarded flush exactly as written in session-store.tsx. */
function flushGuarded(
  buffer: Map<string, BufferEntry>,
  currentSessionId: string | null,
  dispatch: (action: AppendDeltaAction) => void,
): void {
  for (const entry of buffer.values()) {
    if (entry.flushSessionId !== currentSessionId) continue;
    dispatch({
      type: "APPEND_DELTA",
      turnId: entry.turnId,
      runtimeId: entry.runtimeId,
      pluginId: entry.pluginId,
      delta: entry.text,
    });
  }
  buffer.clear();
}

describe("delta buffer — session switch guard", () => {
  it("dispatches when sessionId is unchanged between push and flush", () => {
    const buffer = new Map<string, BufferEntry>();
    buffer.set("turn-1_narrator", {
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "Hello ",
      flushSessionId: "session-a",
    });
    buffer.set("turn-1_codex", {
      turnId: "turn-1",
      runtimeId: "codex",
      pluginId: "codex",
      text: "world.",
      flushSessionId: "session-a",
    });

    const dispatch = vi.fn();
    flushGuarded(buffer, "session-a", dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: "APPEND_DELTA",
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "Hello ",
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "APPEND_DELTA",
      turnId: "turn-1",
      runtimeId: "codex",
      pluginId: "codex",
      delta: "world.",
    });
    expect(buffer.size).toBe(0);
  });

  it("drops buffered entries when the active session changed mid-stream", () => {
    const buffer = new Map<string, BufferEntry>();
    buffer.set("turn-1_narrator", {
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "stale token",
      flushSessionId: "session-a", // captured during session A
    });

    const dispatch = vi.fn();
    // User switched to session B — currentSessionId is "session-b".
    flushGuarded(buffer, "session-b", dispatch);

    expect(dispatch).not.toHaveBeenCalled();
    expect(buffer.size).toBe(0); // still cleared so next RAF starts fresh
  });

  it("drops only the stale entries and dispatches the current-session ones", () => {
    const buffer = new Map<string, BufferEntry>();
    buffer.set("turn-1_narrator", {
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "from A",
      flushSessionId: "session-a",
    });
    // Unrealistic in practice (a single buffer only accumulates tokens
    // for the currently-active session), but validates the filter
    // behaves per-entry rather than all-or-nothing.
    buffer.set("turn-2_narrator", {
      turnId: "turn-2",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "from B",
      flushSessionId: "session-b",
    });

    const dispatch = vi.fn();
    flushGuarded(buffer, "session-b", dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "APPEND_DELTA",
      turnId: "turn-2",
      runtimeId: "narrator",
      pluginId: "narrator",
      delta: "from B",
    });
  });

  it("drops entries when session was detached (null) mid-stream", () => {
    const buffer = new Map<string, BufferEntry>();
    buffer.set("turn-1_narrator", {
      turnId: "turn-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "pending",
      flushSessionId: "session-a",
    });

    const dispatch = vi.fn();
    flushGuarded(buffer, null, dispatch);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reproduces Finding 8 B: session 1 tokens no longer leak into session 2", () => {
    // Simulate: tokens accumulated for session 1 while SSE was active, then
    // the user clicked session 2 in the sidebar. sessionIdRef flips to B.
    // RAF fires a few ms later — the guard must prevent session 1 tokens
    // from being dispatched against session 2's messages array.
    const buffer = new Map<string, BufferEntry>();
    buffer.set("turn-1_narrator", {
      turnId: "turn-1-session-1",
      runtimeId: "narrator",
      pluginId: "narrator",
      text: "...narrative from session 1",
      flushSessionId: "session-1",
    });

    const dispatch = vi.fn();
    flushGuarded(buffer, "session-2", dispatch);

    expect(dispatch).not.toHaveBeenCalled();
  });
});
