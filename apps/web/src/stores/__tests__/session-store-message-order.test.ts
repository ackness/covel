import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";
import { orderStoryBeforePluginMessages } from "../session-store/message-order.js";
import type { StreamMessage } from "../session-store/types.js";

const message = (
  id: string,
  kind: StreamMessage["kind"],
  turnId = "turn-1",
): StreamMessage => ({
  id,
  kind,
  turnId,
  role: "assistant",
  content: id,
  timestamp: "2026-09-05T00:00:00.000Z",
});

describe("story and derived message order", () => {
  it("places a late streaming story before an already received plugin surface", () => {
    const surface = message("surface", "plugin-message");
    const state = reducer(
      { ...initialState, messages: [surface] },
      {
        type: "APPEND_DELTA",
        turnId: "turn-1",
        runtimeId: "story-runtime",
        pluginId: "story-plugin",
        delta: "Opening",
      },
    );
    expect(state.messages.map((m) => m.kind)).toEqual([
      "story",
      "plugin-message",
    ]);
    const completed = reducer(state, {
      type: "COMPLETE_MESSAGE",
      turnId: "turn-1",
      runtimeId: "story-runtime",
      message: message("final-story", "story"),
    });
    expect(completed.messages.map((m) => m.id)).toEqual([
      "final-story",
      "surface",
    ]);
  });

  it("also orders a non-streamed completion without disturbing other turns", () => {
    const earlier = message("earlier", "story", "turn-0");
    const first = message("first-surface", "plugin-message");
    const second = message("second-surface", "plugin-message");
    const state = reducer(
      { ...initialState, messages: [earlier, first, second] },
      {
        type: "COMPLETE_MESSAGE",
        turnId: "turn-1",
        runtimeId: "story-runtime",
        message: message("final-story", "story"),
      },
    );
    expect(state.messages.map((m) => m.id)).toEqual([
      "earlier",
      "final-story",
      "first-surface",
      "second-surface",
    ]);
    expect(orderStoryBeforePluginMessages(state.messages)).toBe(state.messages);
  });
});
