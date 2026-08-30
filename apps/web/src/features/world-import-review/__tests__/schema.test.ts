import { describe, expect, it } from "vitest";
import fixtureDraftJson from "../fixture/world-import-draft-v0.json";
import { parseWorldImportDraft } from "../types.js";

describe("parseWorldImportDraft", () => {
  it("accepts the frozen v0 fixture", () => {
    const parsed = parseWorldImportDraft(fixtureDraftJson);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.version).toBe("v0");
      expect(parsed.draft.entries.length).toBe(9);
      expect(parsed.draft.sources.length).toBe(1);
    }
  });

  it("covers every entry type and provenance status required by the UI", () => {
    const parsed = parseWorldImportDraft(fixtureDraftJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const types = new Set(parsed.draft.entries.map((e) => e.type));
    expect([...types].sort()).toEqual(
      [
        "character",
        "event",
        "faction",
        "item",
        "location",
        "power_system",
        "relation",
        "rule",
      ].sort(),
    );
    const statuses = new Set(
      parsed.draft.entries.map((e) => e.provenanceStatus),
    );
    expect(statuses).toEqual(
      new Set(["source-backed", "ai-inferred", "conflict"]),
    );
  });

  it("rejects entries with an unknown provenance status", () => {
    const broken = {
      version: "v0",
      id: "x",
      title: "t",
      sources: [],
      summary: "",
      entries: [
        {
          id: "e1",
          type: "character",
          name: "n",
          aliases: [],
          content: "c",
          provenanceStatus: "made-up",
          sourceRefs: [],
          userEdited: false,
        },
      ],
    };
    const parsed = parseWorldImportDraft(broken);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("provenanceStatus");
    }
  });

  it("rejects a draft missing its id", () => {
    const parsed = parseWorldImportDraft({
      version: "v0",
      title: "t",
      sources: [],
      summary: "",
      entries: [],
    });
    expect(parsed.ok).toBe(false);
  });
});
