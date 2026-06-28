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

  it("treats a non-string _eventType (number) as a normal chat message", () => {
    const value = JSON.stringify({ _eventType: 42, data: "x" });
    expect(resolveBlockSubmission("blk", value)).toEqual({
      kind: "message",
      content: value,
    });
  });

  it("treats a JSON array payload as a normal chat message", () => {
    const value = JSON.stringify([1, 2, 3]);
    expect(resolveBlockSubmission("blk", value)).toEqual({
      kind: "message",
      content: value,
    });
  });

  it("treats JSON null / number literals as a normal chat message (no throw)", () => {
    expect(resolveBlockSubmission("blk", "null")).toEqual({
      kind: "message",
      content: "null",
    });
    expect(resolveBlockSubmission("blk", "5")).toEqual({
      kind: "message",
      content: "5",
    });
  });

  it("strips _eventType and preserves all sibling fields in eventData", () => {
    const result = resolveBlockSubmission(
      "blk",
      JSON.stringify({
        _eventType: "x.y",
        a: 1,
        b: "two",
        c: { nested: true },
      }),
    );
    expect(result).toEqual({
      kind: "trigger_event",
      eventType: "x.y",
      eventData: { a: 1, b: "two", c: { nested: true } },
    });
  });

  it("documents current behavior: a whitespace-only _eventType (length>0) routes as a trigger_event", () => {
    const result = resolveBlockSubmission(
      "blk",
      JSON.stringify({ _eventType: " ", data: 1 }),
    );
    expect(result).toEqual({
      kind: "trigger_event",
      eventType: " ",
      eventData: { data: 1 },
    });
  });
});
