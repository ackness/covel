import { describe, expect, it } from "vitest";

import {
  isAccountFailure,
  isCompleteFinishReason,
  unifyFinishReason,
} from "../src/index.js";

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
    ["model_length", "length"],
    ["ERROR_LIMIT", "length"],
    ["SPII", "content_filter"],
    ["IMAGE_SAFETY", "content_filter"],
    ["ERROR_TOXIC", "content_filter"],
    ["MALFORMED_FUNCTION_CALL", "error"],
    ["pause_turn", "other"],
    ["insufficient_system_resource", "other"],
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

describe("isCompleteFinishReason", () => {
  it("counts only a normal end and a tool request as a whole answer", () => {
    expect(isCompleteFinishReason("stop")).toBe(true);
    expect(isCompleteFinishReason("tool_calls")).toBe(true);
    for (const reason of [
      "length",
      "content_filter",
      "error",
      "other",
    ] as const)
      expect(isCompleteFinishReason(reason)).toBe(false);
    expect(
      isCompleteFinishReason(unifyFinishReason("insufficient_system_resource")),
    ).toBe(false);
  });
});

describe("isAccountFailure", () => {
  it("is an empty account or a refused key, not a passing fault", () => {
    expect(isAccountFailure("quota")).toBe(true);
    expect(isAccountFailure("auth")).toBe(true);
    for (const kind of [
      "rate_limited",
      "overloaded",
      "server",
      "timeout",
    ] as const)
      expect(isAccountFailure(kind)).toBe(false);
  });
});
