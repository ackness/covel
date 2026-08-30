import Dexie, { type Table } from "dexie";
import { parseWorldImportDraft, type WorldImportDraft } from "./types.js";

/**
 * Local persistence for world-import review drafts, so a saved draft
 * survives refresh / reopen. Deliberately a small dedicated database —
 * game data lives in BrowserVault and must not be mixed with review-only
 * working state.
 */

export const WORLD_IMPORT_DRAFT_DB_NAME = "covel-world-import-review";

interface DraftRecord {
  readonly draftId: string;
  readonly savedAt: string;
  readonly draft: WorldImportDraft;
}

export interface SavedDraft {
  readonly savedAt: string;
  readonly draft: WorldImportDraft;
}

export class WorldImportDraftStore {
  private readonly db: Dexie;
  private readonly drafts: Table<DraftRecord, string>;

  constructor(dbName: string = WORLD_IMPORT_DRAFT_DB_NAME) {
    this.db = new Dexie(dbName);
    this.db.version(1).stores({ drafts: "draftId" });
    this.drafts = this.db.table("drafts");
  }

  async load(draftId: string): Promise<SavedDraft | null> {
    const record = await this.drafts.get(draftId);
    if (!record) return null;
    // Validate on read: a corrupted or schema-drifted record must fail
    // loudly instead of feeding broken data into the review UI.
    const parsed = parseWorldImportDraft(record.draft);
    if (!parsed.ok) {
      throw new Error(
        `Saved draft "${draftId}" failed validation: ${parsed.error}`,
      );
    }
    return { savedAt: record.savedAt, draft: parsed.draft };
  }

  async save(draft: WorldImportDraft): Promise<string> {
    const savedAt = new Date().toISOString();
    await this.drafts.put({
      draftId: draft.id,
      savedAt,
      draft,
    });
    return savedAt;
  }

  async clear(draftId: string): Promise<void> {
    await this.drafts.delete(draftId);
  }
}
