import { describe, expect, it } from "vitest";
import fixtureDraftJson from "../fixture/world-import-draft-v0.json";
import {
  acceptAiInference,
  countByProvenance,
  countByType,
  deleteEntry,
  filterEntriesByType,
  findEntry,
  resolveSourceTitle,
  setConflictResolved,
  updateEntry,
} from "../draft-actions.js";
import { buildExportPayload } from "../draft-service.js";
import { parseWorldImportDraft } from "../types.js";

function fixture() {
  const parsed = parseWorldImportDraft(fixtureDraftJson);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.draft;
}

describe("draft-actions", () => {
  it("updateEntry stamps userEdited and patches only the target entry", () => {
    const draft = fixture();
    const next = updateEntry(draft, "char-lu-mingfei", {
      name: "路明非(审)",
      aliases: ["路少爷", "LU"],
    });
    const edited = findEntry(next, "char-lu-mingfei");
    expect(edited?.userEdited).toBe(true);
    expect(edited?.name).toBe("路明非(审)");
    expect(edited?.aliases).toEqual(["路少爷", "LU"]);
    // Untouched entries stay pristine.
    expect(findEntry(next, "char-nono")?.userEdited).toBe(false);
  });

  it("acceptAiInference only affects ai-inferred entries", () => {
    const draft = fixture();
    const accepted = acceptAiInference(draft, "faction-dragon-research");
    expect(findEntry(accepted, "faction-dragon-research")?.aiAccepted).toBe(
      true,
    );
    // A source-backed entry must not gain the flag.
    const refused = acceptAiInference(draft, "char-lu-mingfei");
    expect(findEntry(refused, "char-lu-mingfei")?.aiAccepted).toBeUndefined();
  });

  it("deleteEntry removes exactly one entry", () => {
    const draft = fixture();
    const next = deleteEntry(draft, "relation-lu-nono");
    expect(findEntry(next, "relation-lu-nono")).toBeNull();
    expect(next.entries.length).toBe(draft.entries.length - 1);
  });

  it("setConflictResolved only affects conflict entries", () => {
    const draft = fixture();
    const next = setConflictResolved(draft, "rule-blood-suppression", true);
    expect(findEntry(next, "rule-blood-suppression")?.conflictResolved).toBe(
      true,
    );
    const ignored = setConflictResolved(draft, "char-lu-mingfei", true);
    expect(
      findEntry(ignored, "char-lu-mingfei")?.conflictResolved,
    ).toBeUndefined();
  });

  it("counts entries by type and provenance", () => {
    const draft = fixture();
    const byType = countByType(draft);
    expect(byType.character).toBe(2);
    expect(byType.rule).toBe(1);
    const byProvenance = countByProvenance(draft);
    expect(byProvenance.total).toBe(9);
    expect(byProvenance.sourceBacked).toBe(6);
    expect(byProvenance.aiInferred).toBe(2);
    expect(byProvenance.conflict).toBe(1);
    expect(byProvenance.unresolvedConflicts).toBe(1);
    const resolved = setConflictResolved(draft, "rule-blood-suppression", true);
    expect(countByProvenance(resolved).unresolvedConflicts).toBe(0);
  });

  it("filters entries by type", () => {
    const draft = fixture();
    expect(filterEntriesByType(draft, "character").map((e) => e.id)).toEqual([
      "char-lu-mingfei",
      "char-nono",
    ]);
    expect(filterEntriesByType(draft, null).length).toBe(9);
  });

  it("resolves source titles with a fallback to the raw id", () => {
    const draft = fixture();
    expect(resolveSourceTitle(draft, "src-longzu-book1-txt")).toContain(
      "龙族 I",
    );
    expect(resolveSourceTitle(draft, "missing")).toBe("missing");
  });

  it("export payload keeps every owner decision", () => {
    let draft = fixture();
    draft = updateEntry(draft, "char-lu-mingfei", { name: "路明非(审)" });
    draft = acceptAiInference(draft, "faction-dragon-research");
    draft = setConflictResolved(draft, "rule-blood-suppression", true);
    draft = deleteEntry(draft, "relation-lu-nono");
    const payload = JSON.parse(buildExportPayload(draft));
    const byId = new Map(payload.entries.map((e: { id: string }) => [e.id, e]));
    expect(byId.get("char-lu-mingfei")).toMatchObject({
      name: "路明非(审)",
      userEdited: true,
    });
    expect(byId.get("faction-dragon-research")).toMatchObject({
      aiAccepted: true,
    });
    expect(byId.get("rule-blood-suppression")).toMatchObject({
      conflictResolved: true,
    });
    expect(byId.has("relation-lu-nono")).toBe(false);
    expect(payload.version).toBe("v0");
  });
});
