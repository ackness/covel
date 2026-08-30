import type {
  EntryType,
  ProvenanceStatus,
  WorldImportDraft,
  WorldImportDraftEntry,
} from "./types.js";

/**
 * Pure state transitions over a WorldImportDraft. The review UI and its
 * tests both go through these; no React and no persistence here.
 */

/** Content edits by the owner (name / aliases / content / conflict notes). */
export type EntryEditPatch = Partial<
  Pick<WorldImportDraftEntry, "name" | "aliases" | "content" | "conflictNotes">
>;

export function updateEntry(
  draft: WorldImportDraft,
  entryId: string,
  patch: EntryEditPatch,
): WorldImportDraft {
  return {
    ...draft,
    entries: draft.entries.map((entry) =>
      entry.id === entryId ? { ...entry, ...patch, userEdited: true } : entry,
    ),
  };
}

/** Owner decision to keep an AI-inferred entry. Never touches userEdited. */
export function acceptAiInference(
  draft: WorldImportDraft,
  entryId: string,
): WorldImportDraft {
  return {
    ...draft,
    entries: draft.entries.map((entry) =>
      entry.id === entryId && entry.provenanceStatus === "ai-inferred"
        ? { ...entry, aiAccepted: true }
        : entry,
    ),
  };
}

export function deleteEntry(
  draft: WorldImportDraft,
  entryId: string,
): WorldImportDraft {
  return {
    ...draft,
    entries: draft.entries.filter((entry) => entry.id !== entryId),
  };
}

export function setConflictResolved(
  draft: WorldImportDraft,
  entryId: string,
  resolved: boolean,
): WorldImportDraft {
  return {
    ...draft,
    entries: draft.entries.map((entry) =>
      entry.id === entryId && entry.provenanceStatus === "conflict"
        ? { ...entry, conflictResolved: resolved }
        : entry,
    ),
  };
}

export function findEntry(
  draft: WorldImportDraft,
  entryId: string | null,
): WorldImportDraftEntry | null {
  if (!entryId) return null;
  return draft.entries.find((entry) => entry.id === entryId) ?? null;
}

export function countByType(
  draft: WorldImportDraft,
): Record<EntryType, number> {
  const counts = {
    character: 0,
    faction: 0,
    location: 0,
    item: 0,
    rule: 0,
    power_system: 0,
    event: 0,
    relation: 0,
  } as Record<EntryType, number>;
  for (const entry of draft.entries) {
    counts[entry.type] += 1;
  }
  return counts;
}

export interface ProvenanceCounts {
  readonly total: number;
  readonly sourceBacked: number;
  readonly aiInferred: number;
  readonly conflict: number;
  readonly unresolvedConflicts: number;
}

export function countByProvenance(draft: WorldImportDraft): ProvenanceCounts {
  const counts = { total: draft.entries.length } as ProvenanceCounts & {
    sourceBacked: number;
    aiInferred: number;
    conflict: number;
    unresolvedConflicts: number;
  };
  counts.sourceBacked = 0;
  counts.aiInferred = 0;
  counts.conflict = 0;
  counts.unresolvedConflicts = 0;
  for (const entry of draft.entries) {
    if (entry.provenanceStatus === "source-backed") counts.sourceBacked += 1;
    if (entry.provenanceStatus === "ai-inferred") counts.aiInferred += 1;
    if (entry.provenanceStatus === "conflict") {
      counts.conflict += 1;
      if (!entry.conflictResolved) counts.unresolvedConflicts += 1;
    }
  }
  return counts;
}

export function filterEntriesByType(
  draft: WorldImportDraft,
  type: EntryType | null,
): WorldImportDraftEntry[] {
  if (!type) return draft.entries;
  return draft.entries.filter((entry) => entry.type === type);
}

export function provenanceOrder(status: ProvenanceStatus): number {
  // Conflicts first (they need the owner most), then AI inferences, then
  // source-backed entries. Used only as a stable display hint, not a sort
  // requirement — the list otherwise keeps import order.
  if (status === "conflict") return 0;
  if (status === "ai-inferred") return 1;
  return 2;
}

export function resolveSourceTitle(
  draft: WorldImportDraft,
  sourceId: string,
): string {
  return (
    draft.sources.find((source) => source.id === sourceId)?.title ?? sourceId
  );
}
