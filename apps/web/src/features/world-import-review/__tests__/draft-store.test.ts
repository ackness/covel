import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import fixtureDraftJson from "../fixture/world-import-draft-v0.json";
import { WorldImportDraftStore } from "../draft-store.js";
import { parseWorldImportDraft, type WorldImportDraft } from "../types.js";

function fixture(): WorldImportDraft {
  const parsed = parseWorldImportDraft(fixtureDraftJson);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.draft;
}

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-world-import-review-${dbCounter}`);
}

describe("WorldImportDraftStore", () => {
  it("returns null when no draft was saved", async () => {
    const store = newStore();
    expect(await store.load("world-import-fixture-longzu-v0")).toBeNull();
  });

  it("saves and reloads a draft unchanged", async () => {
    const store = newStore();
    const draft = fixture();
    const savedAt = await store.save(draft);
    expect(typeof savedAt).toBe("string");

    const reloaded = await store.load(draft.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.savedAt).toBe(savedAt);
    expect(reloaded?.draft).toEqual(draft);
  });

  it("overwrites a previous save for the same draft id", async () => {
    const store = newStore();
    const draft = fixture();
    await store.save(draft);
    const edited = {
      ...draft,
      entries: draft.entries.map((e) =>
        e.id === "char-lu-mingfei" ? { ...e, userEdited: true } : e,
      ),
    };
    await store.save(edited);
    const reloaded = await store.load(draft.id);
    expect(
      reloaded?.draft.entries.find((e) => e.id === "char-lu-mingfei")
        ?.userEdited,
    ).toBe(true);
  });

  it("clear removes the saved draft", async () => {
    const store = newStore();
    const draft = fixture();
    await store.save(draft);
    await store.clear(draft.id);
    expect(await store.load(draft.id)).toBeNull();
  });

  it("rejects a corrupted saved record instead of returning it", async () => {
    const store = newStore();
    const draft = fixture();
    await store.save(draft);
    // Corrupt the record behind Dexie's back.
    const db = await (
      store as unknown as {
        db: { table: (n: string) => { put: (r: unknown) => Promise<void> } };
      }
    ).db.table("drafts");
    await db.put({
      draftId: draft.id,
      savedAt: new Date().toISOString(),
      draft: { ...draft, entries: "not-an-array" },
    });
    await expect(store.load(draft.id)).rejects.toThrow(/failed validation/);
  });
});
