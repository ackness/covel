import { describe, expect, it } from "vitest";
import {
  buildSearchToolsDescription,
  parameterSchemaSearchText,
  rankToolSearchDocs,
  SEARCH_TOOLS_JSON_SCHEMA,
  tokenizeForToolSearch,
  type ToolSearchDoc,
} from "../src/builtin/tool-search.js";

const DOCS: ToolSearchDoc[] = [
  {
    key: "set-scene-background",
    text: "set-scene-background Switch the current scene background image to a registered scene variant (day/night). sceneId variant",
  },
  {
    key: "roll-dice",
    text: "roll-dice Roll dice with an expression like 2d6+3 and return the total. expression",
  },
  {
    key: "unlock-codex-entry",
    text: "unlock-codex-entry 解锁一条图鉴条目，包含条目 ID 与解锁原因。entryId reason",
  },
  {
    key: "grant-item",
    text: "grant-item Give the player an inventory item with quantity. itemId quantity",
  },
];

describe("rankToolSearchDocs (BM25)", () => {
  it("ranks the capability-matching tool first for an English query", () => {
    const ranked = rankToolSearchDocs("change scene background image", DOCS, 3);
    expect(ranked[0]).toBe("set-scene-background");
  });

  it("matches Chinese queries via the CJK substring path", () => {
    const ranked = rankToolSearchDocs("解锁图鉴", DOCS, 3);
    expect(ranked[0]).toBe("unlock-codex-entry");
  });

  it("drops zero-overlap documents and respects the limit", () => {
    const ranked = rankToolSearchDocs("dice roll", DOCS, 1);
    expect(ranked).toEqual(["roll-dice"]);
  });

  it("returns empty for an empty/stop-word query or empty corpus", () => {
    expect(rankToolSearchDocs("", DOCS, 5)).toEqual([]);
    expect(rankToolSearchDocs("a", DOCS, 5)).toEqual([]); // <2 chars filtered
    expect(rankToolSearchDocs("dice", [], 5)).toEqual([]);
    expect(rankToolSearchDocs("dice", DOCS, 0)).toEqual([]);
  });

  it("is deterministic on ties (name tie-break)", () => {
    const twins: ToolSearchDoc[] = [
      { key: "b-tool", text: "shared capability words" },
      { key: "a-tool", text: "shared capability words" },
    ];
    expect(rankToolSearchDocs("capability", twins, 2)).toEqual([
      "a-tool",
      "b-tool",
    ]);
  });
});

describe("tokenizeForToolSearch", () => {
  it("keeps term frequencies (no dedupe) and lowercases", () => {
    expect(tokenizeForToolSearch("Scene scene BACKGROUND")).toEqual([
      "scene",
      "scene",
      "background",
    ]);
  });
});

describe("parameterSchemaSearchText", () => {
  it("extracts property names and descriptions recursively", () => {
    const text = parameterSchemaSearchText({
      type: "object",
      properties: {
        sceneId: { type: "string", description: "Registered scene id" },
        options: {
          type: "object",
          properties: {
            variant: { type: "string", description: "day or night" },
          },
        },
        tags: { type: "array", items: { description: "tag text" } },
      },
    });
    expect(text).toContain("sceneId");
    expect(text).toContain("Registered scene id");
    expect(text).toContain("variant");
    expect(text).toContain("day or night");
    expect(text).toContain("tag text");
    expect(text).not.toContain("object");
  });

  it("returns empty for undefined", () => {
    expect(parameterSchemaSearchText(undefined)).toBe("");
  });
});

describe("search-tools contract", () => {
  it("schema requires query and description advertises the pool", () => {
    expect(SEARCH_TOOLS_JSON_SCHEMA["required"]).toEqual(["query"]);
    const desc = buildSearchToolsDescription(12, "mega-plugin");
    expect(desc).toContain("12");
    expect(desc).toContain("mega-plugin");
  });
});
