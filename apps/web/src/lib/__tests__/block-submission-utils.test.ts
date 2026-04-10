import { describe, it, expect } from "vitest";
import { resolveBlockSubmission } from "../block-submission-utils.js";

describe("resolveBlockSubmission", () => {
  it("routes event submissions via _eventType convention", () => {
    const result = resolveBlockSubmission(
      "any_block_type",
      JSON.stringify({
        _eventType: "image.settings.updated",
        settings: { style: "anime", multiPanel: true },
      }),
    );

    expect(result).toEqual({
      kind: "trigger_event",
      eventType: "image.settings.updated",
      eventData: {
        settings: { style: "anime", multiPanel: true },
      },
    });
  });

  it("falls back to a normal chat message for invalid JSON", () => {
    const result = resolveBlockSubmission("some_block", "not-json");
    expect(result).toEqual({ kind: "message", content: "not-json" });
  });

  it("treats JSON without _eventType as normal chat message", () => {
    const result = resolveBlockSubmission(
      "choice_set",
      JSON.stringify({ action: "attack" }),
    );
    expect(result).toEqual({
      kind: "message",
      content: JSON.stringify({ action: "attack" }),
    });
  });

  it("treats empty _eventType as normal chat message", () => {
    const result = resolveBlockSubmission(
      "any_block",
      JSON.stringify({ _eventType: "", data: 123 }),
    );
    expect(result).toEqual({
      kind: "message",
      content: JSON.stringify({ _eventType: "", data: 123 }),
    });
  });

  it("leaves plain text as normal chat messages", () => {
    const result = resolveBlockSubmission("choice_set", "attack");
    expect(result).toEqual({ kind: "message", content: "attack" });
  });
});
