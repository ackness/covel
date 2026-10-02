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
