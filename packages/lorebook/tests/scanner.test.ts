import { describe, it, expect } from "vitest";
import type { TokenEstimator } from "@covel/context";
import { scanLorebook, type ScanMessage } from "../src/scanner.js";
import type { LorebookEntry } from "../src/types.js";

/** Deterministic estimator: 1 token per non-space character. */
const charEstimator: TokenEstimator = (text: string) =>
  text.replace(/\s+/g, "").length;

function entry(partial: Partial<LorebookEntry> & Pick<LorebookEntry, "id" | "content" | "strategy">): LorebookEntry {
  return {
    source: "world",
    keys: [],
    selectiveLogic: "and_any",
    position: "after_char_defs",
    insertionOrder: 100,
    enabled: true,
    ...partial,
  } as LorebookEntry;
}

function msg(role: "user" | "assistant" | "system", content: string): ScanMessage {
  return { role, content };
}

describe("scanLorebook", () => {
  it("always includes constant entries when budget permits", () => {
    const entries = [
      entry({ id: "c1", strategy: "constant", content: "always-on" }),
    ];
    const result = scanLorebook({
      entries,
      messages: [],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.get("after_char_defs")).toHaveLength(1);
    expect(result.totalTokens).toBe(charEstimator("always-on"));
    expect(result.droppedIds).toEqual([]);
  });

  it("triggers a selective entry when a key appears in recent messages", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        content: "Qingping Sect lore",
        keys: ["Qingping"],
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [msg("user", "I visit the Qingping valley")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.get("after_char_defs")).toHaveLength(1);
  });

  it("does not trigger a selective entry when no key matches", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        content: "Qingping Sect lore",
        keys: ["Qingping"],
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [msg("user", "I head to the market")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.size).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it("matching is case-insensitive", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        content: "ok",
        keys: ["QINGPING"],
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [msg("user", "the qingping sect")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.get("after_char_defs")).toHaveLength(1);
  });

  it("and_any triggers when at least one key matches", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        selectiveLogic: "and_any",
        content: "ok",
        keys: ["alpha", "beta"],
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [msg("user", "only beta here")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.size).toBe(1);
  });

  it("and_all requires every key to match", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        selectiveLogic: "and_all",
        content: "ok",
        keys: ["alpha", "beta"],
      }),
    ];
    // Only one key present → should NOT fire.
    const onlyOne = scanLorebook({
      entries,
      messages: [msg("user", "only alpha here")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(onlyOne.entriesByPosition.size).toBe(0);

    // Both keys present → should fire.
    const both = scanLorebook({
      entries,
      messages: [msg("user", "alpha and beta and gamma")],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(both.entriesByPosition.size).toBe(1);
  });

  it("throws a clear error for not_any / not_all (not implemented in MVP)", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        selectiveLogic: "not_any",
        content: "ok",
        keys: ["alpha"],
      }),
    ];
    expect(() =>
      scanLorebook({
        entries,
        messages: [msg("user", "alpha")],
        budget: { maxTokens: 100, estimator: charEstimator },
      }),
    ).toThrow(/not implemented in the S3-T1 MVP/);
  });

  it("respects scanDepth — out-of-window messages are not scanned", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        content: "ok",
        keys: ["secret"],
        scanDepth: 5,
      }),
    ];

    // Build 15 messages; the keyword appears only in message index 4.
    // With scanDepth=5 we scan messages 10..14, so the hit is outside.
    const messages: ScanMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(msg("user", i === 4 ? "the secret is here" : `filler ${i}`));
    }

    const outOfRange = scanLorebook({
      entries,
      messages,
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(outOfRange.entriesByPosition.size).toBe(0);

    // Put the keyword in the last message — now it's in range.
    const inRangeMsgs = [...messages];
    inRangeMsgs[14] = msg("user", "secret again");
    const inRange = scanLorebook({
      entries,
      messages: inRangeMsgs,
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(inRange.entriesByPosition.size).toBe(1);
  });

  it("enforces the budget cap and drops overflowing selectives", () => {
    const entries = [
      entry({
        id: "s1",
        strategy: "selective",
        content: "aaaaaaaa", // 8 tokens
        keys: ["k"],
        insertionOrder: 100,
      }),
      entry({
        id: "s2",
        strategy: "selective",
        content: "bbbbbbbb", // 8 tokens
        keys: ["k"],
        insertionOrder: 200,
      }),
    ];

    // Budget room for only one of the two 8-token entries. Higher
    // insertionOrder (s2) should win.
    const result = scanLorebook({
      entries,
      messages: [msg("user", "k k k")],
      budget: { maxTokens: 10, estimator: charEstimator },
    });

    const afterCharDefs = result.entriesByPosition.get("after_char_defs") ?? [];
    expect(afterCharDefs).toHaveLength(1);
    expect(afterCharDefs[0]!.id).toBe("s2");
    expect(result.droppedIds).toEqual(["s1"]);
    expect(result.totalTokens).toBe(8);
  });

  it("warns and drops when a single constant entry can't fit the budget", () => {
    const entries = [
      entry({
        id: "c1",
        strategy: "constant",
        content: "aaaaaaaaaaaaaaaa", // 16 tokens
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [],
      budget: { maxTokens: 8, estimator: charEstimator },
    });
    expect(result.entriesByPosition.size).toBe(0);
    expect(result.droppedIds).toEqual(["c1"]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/constant entry 'c1' dropped/);
  });

  it("reserves budget for constants before selectives", () => {
    // Constant is 6 tokens, selective is 5 tokens, budget is 10 — only
    // the constant fits first; the selective then would need 5 but only
    // 4 remain, so it should be dropped.
    const entries = [
      entry({
        id: "c1",
        strategy: "constant",
        content: "aaaaaa", // 6
      }),
      entry({
        id: "s1",
        strategy: "selective",
        content: "bbbbb", // 5
        keys: ["k"],
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [msg("user", "k")],
      budget: { maxTokens: 10, estimator: charEstimator },
    });
    expect(result.totalTokens).toBe(6);
    expect(result.droppedIds).toEqual(["s1"]);
  });

  it("groups accepted entries into position buckets preserving insertionOrder ascending", () => {
    const entries = [
      entry({
        id: "c_top",
        strategy: "constant",
        content: "x",
        position: "before_char_defs",
        insertionOrder: 10,
      }),
      entry({
        id: "c_bot",
        strategy: "constant",
        content: "y",
        position: "before_char_defs",
        insertionOrder: 5,
      }),
      entry({
        id: "c_mid",
        strategy: "constant",
        content: "z",
        position: "after_char_defs",
        insertionOrder: 100,
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    const top = result.entriesByPosition.get("before_char_defs") ?? [];
    expect(top.map(e => e.id)).toEqual(["c_bot", "c_top"]); // 5 before 10
    expect(result.entriesByPosition.get("after_char_defs")).toHaveLength(1);
  });

  it("ignores disabled entries", () => {
    const entries = [
      entry({
        id: "c1",
        strategy: "constant",
        content: "x",
        enabled: false,
      }),
    ];
    const result = scanLorebook({
      entries,
      messages: [],
      budget: { maxTokens: 100, estimator: charEstimator },
    });
    expect(result.entriesByPosition.size).toBe(0);
  });
});
