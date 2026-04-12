import { describe, it, expect } from "vitest";
import {
  lorebookEntryInputSchema,
  lorebookFileSchema,
  normalizeEntry,
} from "../src/types.js";

describe("lorebookEntryInputSchema", () => {
  it("accepts a minimal valid entry and fills defaults", () => {
    const parsed = lorebookEntryInputSchema.parse({
      id: "a",
      content: "hello",
      strategy: "constant",
    });
    expect(parsed.selectiveLogic).toBe("and_any");
    expect(parsed.position).toBe("after_char_defs");
    expect(parsed.insertionOrder).toBe(100);
    expect(parsed.enabled).toBe(true);
    expect(parsed.keys).toEqual([]);
  });

  it("rejects unknown strategy values (vectorized is intentionally omitted)", () => {
    const result = lorebookEntryInputSchema.safeParse({
      id: "a",
      content: "hi",
      strategy: "vectorized",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields via strict mode", () => {
    const result = lorebookEntryInputSchema.safeParse({
      id: "a",
      content: "hi",
      strategy: "constant",
      bogus: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts all selective logic variants in schema (engine restricts at runtime)", () => {
    for (const logic of ["and_any", "and_all", "not_any", "not_all"] as const) {
      const result = lorebookEntryInputSchema.safeParse({
        id: "a",
        content: "x",
        strategy: "selective",
        selectiveLogic: logic,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("lorebookFileSchema", () => {
  it("accepts a file with an empty entries array", () => {
    const parsed = lorebookFileSchema.parse({ entries: [] });
    expect(parsed.entries).toEqual([]);
  });

  it("defaults entries to an empty array when omitted", () => {
    const parsed = lorebookFileSchema.parse({});
    expect(parsed.entries).toEqual([]);
  });
});

describe("normalizeEntry", () => {
  it("stamps the source and pluginId from defaults", () => {
    const input = lorebookEntryInputSchema.parse({
      id: "a",
      content: "x",
      strategy: "constant",
    });
    const normalized = normalizeEntry(input, {
      source: "plugin",
      pluginId: "example-plugin",
    });
    expect(normalized.source).toBe("plugin");
    expect(normalized.pluginId).toBe("example-plugin");
  });

  it("preserves explicit source/pluginId from the raw entry", () => {
    const input = lorebookEntryInputSchema.parse({
      id: "a",
      source: "session",
      pluginId: "pX",
      content: "x",
      strategy: "constant",
    });
    const normalized = normalizeEntry(input, { source: "world" });
    expect(normalized.source).toBe("session");
    expect(normalized.pluginId).toBe("pX");
  });
});
