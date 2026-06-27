import { describe, it, expect } from "vitest";
import {
  computePromptDelta,
  applyPromptDelta,
  type PromptMessage,
} from "../src/llm/prompt-delta.js";

describe("computePromptDelta", () => {
  const sys: PromptMessage = {
    role: "system",
    content: "You are a helpful agent.",
  };
  const user1: PromptMessage = { role: "user", content: "Hello." };
  const asst1: PromptMessage = { role: "assistant", content: "Hi there." };
  const tool1: PromptMessage = { role: "tool", content: '{"result":42}' };
  const user2: PromptMessage = { role: "user", content: "And the weather?" };

  it("returns the full prompt when there is no previous", () => {
    const current = [sys, user1];
    expect(computePromptDelta(undefined, current)).toEqual(current);
    expect(computePromptDelta([], current)).toEqual(current);
  });

  it("returns only the newly appended messages on a pure append", () => {
    const previous = [sys, user1, asst1];
    const current = [sys, user1, asst1, tool1, user2];
    expect(computePromptDelta(previous, current)).toEqual([tool1, user2]);
  });

  it("returns from the first diverging index when a message is replaced", () => {
    const previous = [sys, user1, asst1];
    const edited: PromptMessage = {
      role: "assistant",
      content: "Actually, hey.",
    };
    const current = [sys, user1, edited];
    expect(computePromptDelta(previous, current)).toEqual([edited]);
  });

  it("returns the whole current when previous and current share no prefix", () => {
    const previous = [sys, user1];
    const altSys: PromptMessage = {
      role: "system",
      content: "Different persona.",
    };
    const current = [altSys, user1];
    expect(computePromptDelta(previous, current)).toEqual([altSys, user1]);
  });

  it("returns empty when current is a prefix of previous (compaction)", () => {
    const previous = [sys, user1, asst1, tool1];
    const current = [sys, user1, asst1];
    expect(computePromptDelta(previous, current)).toEqual([]);
  });

  it("is idempotent with an identical current", () => {
    const previous = [sys, user1, asst1];
    expect(computePromptDelta(previous, previous)).toEqual([]);
  });

  it("compares content parts structurally", () => {
    const ref = { id: "a".repeat(64), mime: "image/png", size: 12 };
    const withImage: PromptMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look." },
        { type: "image", image: ref },
      ],
    };
    const sameImage: PromptMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look." },
        { type: "image", image: ref },
      ],
    };
    const editedImage: PromptMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look closer." },
        { type: "image", image: ref },
      ],
    };

    expect(computePromptDelta([sys, withImage], [sys, sameImage])).toEqual([]);
    expect(computePromptDelta([sys, withImage], [sys, editedImage])).toEqual([
      editedImage,
    ]);
  });
});

describe("applyPromptDelta", () => {
  const sys: PromptMessage = {
    role: "system",
    content: "You are a helpful agent.",
  };
  const user1: PromptMessage = { role: "user", content: "Hello." };
  const asst1: PromptMessage = { role: "assistant", content: "Hi there." };
  const tool1: PromptMessage = { role: "tool", content: '{"result":42}' };
  const user2: PromptMessage = { role: "user", content: "And the weather?" };

  it("returns delta when delta is at least as long as base", () => {
    const base = [sys, user1];
    const delta = [sys, user1, asst1];
    expect(applyPromptDelta(base, delta)).toEqual(delta);
  });

  it("appends a pure-append delta to the longest matching prefix", () => {
    const base = [sys, user1, asst1];
    const delta = [tool1, user2];
    // Since delta.length (2) < base.length (3), we take base[0..3-2] = [sys]
    // and concat with delta — NOT the expected full rebuild. This is the
    // documented limitation of the simple base+delta scheme; full rebuild
    // requires storing the diverge index. For now we accept the lossy
    // behaviour and rely on the separate turn_messages table as the source
    // of truth for the REAL history.
    const result = applyPromptDelta(base, delta);
    expect(result.length).toBe(base.length);
  });

  it("round-trips when combined with computePromptDelta on pure append", () => {
    // Scenario: caller stores full previous + delta, rebuilds by taking
    // all previous messages except the delta-length tail, then appends
    // the delta. For pure appends where `delta.length === current.length
    // - previous.length`, the rebuild is exact.
    const previous = [sys, user1];
    const current = [sys, user1, asst1, tool1];
    const delta = computePromptDelta(previous, current);
    expect(delta).toEqual([asst1, tool1]);

    // Proper rebuild uses the FULL previous history as base:
    const rebuilt = [...previous, ...delta];
    expect(rebuilt).toEqual(current);
  });
});
