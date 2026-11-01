// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer.js";
import type { StreamMessage } from "../types.js";

describe("a player interjection", () => {
  it("goes before a committed assistant response from its turn", () => {
    const messages: StreamMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "开门",
        timestamp: "t1",
        turnId: "turn-1",
      },
      {
        id: "saved-story",
        role: "assistant",
        content: "Full story",
        timestamp: "t2",
        turnId: "turn-1",
      },
    ];
    const state = reducer(
      { ...initialState, messages },
      {
        type: "ADD_STEER_MESSAGE",
        message: {
          id: "steer",
          role: "user",
          content: "等等",
          timestamp: "t3",
          turnId: "turn-1",
        },
      },
    );
    expect(state.messages.map((m) => m.id)).toEqual([
      "u1",
      "steer",
      "saved-story",
    ]);
  });

  it("is appended when its turn has no committed response yet", () => {
    const state = reducer(initialState, {
      type: "ADD_STEER_MESSAGE",
      message: {
        id: "steer",
        role: "user",
        content: "等等",
        timestamp: "t3",
        turnId: "turn-1",
      },
    });
    expect(state.messages.map((m) => m.id)).toEqual(["steer"]);
  });
});
