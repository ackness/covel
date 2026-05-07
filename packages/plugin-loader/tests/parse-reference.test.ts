import { describe, it, expect } from "vitest";
import {
  parseReference,
  shouldInjectReference,
} from "../src/parse-reference.js";
import type { ParsedReference } from "../src/types.js";

describe("parseReference", () => {
  it("should parse frontmatter with keywords", () => {
    const content = [
      "---",
      "keywords: [龙族, 龙鳞, 上古战争, Drakon]",
      "---",
      "",
      "# 龙族传说",
      "",
      "龙族是远古时代最强大的种族。",
    ].join("\n");

    const result = parseReference(content, "references/dragons.md");

    expect(result.filePath).toBe("references/dragons.md");
    expect(result.keywords).toEqual(["龙族", "龙鳞", "上古战争", "Drakon"]);
    expect(result.content).toContain("# 龙族传说");
    expect(result.content).toContain("龙族是远古时代最强大的种族。");
  });

  it("should return empty keywords when no frontmatter", () => {
    const content = "# Plain markdown\n\nNo frontmatter here.";

    const result = parseReference(content, "references/plain.md");

    expect(result.filePath).toBe("references/plain.md");
    expect(result.keywords).toEqual([]);
    expect(result.content).toBe("# Plain markdown\n\nNo frontmatter here.");
  });

  it("should return empty keywords when keywords field is empty array", () => {
    const content = ["---", "keywords: []", "---", "", "Some content."].join(
      "\n",
    );

    const result = parseReference(content, "references/empty-kw.md");

    expect(result.keywords).toEqual([]);
    expect(result.content).toContain("Some content.");
  });

  it("should preserve body content exactly", () => {
    const body = [
      "# Section One",
      "",
      "- item a",
      "- item b",
      "",
      "## Subsection",
      "",
      "Paragraph with **bold** and *italic*.",
    ].join("\n");

    const content = ["---", "keywords: [test]", "---", "", body].join("\n");

    const result = parseReference(content, "references/rich.md");

    // gray-matter trims leading newline from body, so we compare trimmed
    expect(result.content.trim()).toBe(body);
  });
});

describe("shouldInjectReference", () => {
  const makeRef = (keywords: string[]): ParsedReference => ({
    filePath: "test.md",
    keywords,
    content: "test content",
  });

  it("should return true when no keywords (unconditional)", () => {
    expect(shouldInjectReference(makeRef([]), "any context")).toBe(true);
  });

  it("should return true when keyword matches in context", () => {
    const ref = makeRef(["龙族", "精灵"]);
    expect(shouldInjectReference(ref, "这是关于龙族的故事")).toBe(true);
  });

  it("should match case-insensitively", () => {
    const ref = makeRef(["Drakon"]);
    expect(shouldInjectReference(ref, "The drakon awakens.")).toBe(true);
  });

  it("should return false when no keyword matches", () => {
    const ref = makeRef(["龙族", "精灵"]);
    expect(shouldInjectReference(ref, "这是关于人类的故事")).toBe(false);
  });

  it("should match as substring", () => {
    const ref = makeRef(["龙"]);
    expect(shouldInjectReference(ref, "龙族传说")).toBe(true);
  });

  it("should return true if any of multiple keywords matches", () => {
    const ref = makeRef(["水精灵", "龙族"]);
    expect(shouldInjectReference(ref, "这是关于龙族的传说")).toBe(true);
  });
});
