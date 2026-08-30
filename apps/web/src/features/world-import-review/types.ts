import { z } from "zod";

/**
 * WorldImportDraft v0 contract — the fixed shape Dev C's review UI and Dev
 * B's extraction pipeline exchange. Everything the owner sees and edits in
 * the review UI must survive a save / reopen / export round-trip.
 *
 * Two additive optional fields carry UI review decisions that must persist
 * (the v0 contract has no other home for them):
 *   - `aiAccepted` — the owner explicitly accepted an AI-inferred entry.
 *   - `conflictResolved` — the owner marked a conflict entry as resolved.
 * Both are absent in freshly imported drafts and set only by this UI.
 */

export const PROVENANCE_STATUSES = [
  "source-backed",
  "ai-inferred",
  "conflict",
] as const;

export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

export const ENTRY_TYPES = [
  "character",
  "faction",
  "location",
  "item",
  "rule",
  "power_system",
  "event",
  "relation",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export const draftSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Human-readable hint describing what a locator points into. */
  locatorHint: z.string().optional(),
});

export const sourceRefSchema = z.object({
  sourceId: z.string().min(1),
  /** Locator into the source, e.g. chapter / position — owner-readable. */
  locator: z.string().min(1),
  /** Optional short quoted snippet backing the entry. */
  quote: z.string().optional(),
});

export const draftEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(ENTRY_TYPES),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  content: z.string(),
  provenanceStatus: z.enum(PROVENANCE_STATUSES),
  sourceRefs: z.array(sourceRefSchema),
  conflictNotes: z.string().optional(),
  userEdited: z.boolean(),
  aiAccepted: z.boolean().optional(),
  conflictResolved: z.boolean().optional(),
});

export const worldImportDraftSchema = z.object({
  version: z.string().min(1),
  id: z.string().min(1),
  title: z.string().min(1),
  sources: z.array(draftSourceSchema),
  summary: z.string(),
  entries: z.array(draftEntrySchema),
});

export type DraftSource = z.infer<typeof draftSourceSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type WorldImportDraftEntry = z.infer<typeof draftEntrySchema>;
export type WorldImportDraft = z.infer<typeof worldImportDraftSchema>;

export function parseWorldImportDraft(
  input: unknown,
): { ok: true; draft: WorldImportDraft } | { ok: false; error: string } {
  const result = worldImportDraftSchema.safeParse(input);
  if (result.success) {
    return { ok: true, draft: result.data };
  }
  const first = result.error.issues[0];
  const path = first ? first.path.join(".") : "(root)";
  return {
    ok: false,
    error: `WorldImportDraft validation failed at "${path}": ${first ? first.message : "unknown error"}`,
  };
}
