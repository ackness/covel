import { describe, expect, it } from "vitest";

import { unifyFinishReason } from "../src/index.js";

describe("unifyFinishReason", () => {
  it.each([
    ["stop", "stop"],
    ["end_turn", "stop"],
    ["STOP", "stop"],
    ["max_tokens", "length"],
    ["MAX_TOKENS", "length"],
    ["length", "length"],
    ["tool_calls", "tool_calls"],
    ["tool_use", "tool_calls"],
    ["tool-calls", "tool_calls"],
    ["content_filter", "content_filter"],
    ["content-filter", "content_filter"],
    ["refusal", "content_filter"],
    ["SAFETY", "content_filter"],
    ["error", "error"],
    ["pause_turn", "other"],
  ])("reads %s as %s", (raw, unified) => {
    expect(unifyFinishReason(raw)).toBe(unified);
  });

  it("reads a reason the provider left out as a normal end", () => {
    expect(unifyFinishReason(undefined)).toBe("stop");
    expect(unifyFinishReason(null)).toBe("stop");
    expect(unifyFinishReason("")).toBe("stop");
  });

  it("does not read an inherited property name as a reason", () => {
    expect(unifyFinishReason("constructor")).toBe("other");
  });
});
