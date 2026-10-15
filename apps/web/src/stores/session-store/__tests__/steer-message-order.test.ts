// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer.js";
import type { StreamMessage } from "../types.js";

const STREAM_ID_PREFIX = "stream_";

describe("a player interjection", () => {
  it("goes above the text its turn is still streaming, where the commit saves it", () => {
    const messages: StreamMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "开门",
        timestamp: "t1",
        turnId: "turn-1",
      },
      {
        id: `${STREAM_ID_PREFIX}turn-1_plug/story`,
        role: "assistant",
        content: "",
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
      `${STREAM_ID_PREFIX}turn-1_plug/story`,
    ]);
  });

  it("is appended when its turn streams nothing yet", () => {
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
