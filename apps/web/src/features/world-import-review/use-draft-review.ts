import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptAiInference,
  deleteEntry,
  setConflictResolved,
  updateEntry,
  type EntryEditPatch,
} from "./draft-actions.js";
import { fetchFixtureDraft } from "./draft-service.js";
import { WorldImportDraftStore } from "./draft-store.js";
import type { WorldImportDraft } from "./types.js";

/**
 * State owner for the review page. Loads the saved draft when one exists,
 * otherwise falls back to the fixture; edits stay in memory until the owner
 * explicitly saves.
 */

export type ReviewLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

export interface DraftReview {
  readonly loadState: ReviewLoadState;
  readonly draft: WorldImportDraft | null;
  readonly savedAt: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly resetting: boolean;
  editEntry(entryId: string, patch: EntryEditPatch): void;
  acceptAi(entryId: string): void;
  removeEntry(entryId: string): void;
  resolveConflict(entryId: string, resolved: boolean): void;
  save(): Promise<void>;
  resetToFixture(): Promise<void>;
  /** Re-run the initial load (saved draft first, fixture fallback). */
  reload(): Promise<void>;
}

export function useDraftReview(
  storeOverride?: WorldImportDraftStore,
): DraftReview {
  // Keep one store instance for the hook's lifetime: the load effect keys
  // off it, and a per-render default would restart that effect forever.
  const storeRef = useRef<WorldImportDraftStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = storeOverride ?? new WorldImportDraftStore();
  }
  const store = storeRef.current;
  const [loadState, setLoadState] = useState<ReviewLoadState>({
    status: "loading",
  });
  const [draft, setDraft] = useState<WorldImportDraft | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const draftRef = useRef<WorldImportDraft | null>(null);
  draftRef.current = draft;

  const loadFrom = useCallback(
    async (options: { preferSaved: boolean }) => {
      setLoadState({ status: "loading" });
      try {
        const fixture = await fetchFixtureDraft();
        const saved = options.preferSaved ? await store.load(fixture.id) : null;
        setDraft(saved ? saved.draft : fixture);
        setSavedAt(saved ? saved.savedAt : null);
        setDirty(false);
        setLoadState({ status: "ready" });
      } catch (error) {
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [store],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fixture = await fetchFixtureDraft();
        const saved = await store.load(fixture.id);
        if (cancelled) return;
        setDraft(saved ? saved.draft : fixture);
        setSavedAt(saved ? saved.savedAt : null);
        setDirty(false);
        setLoadState({ status: "ready" });
      } catch (error) {
        if (cancelled) return;
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const mutate = useCallback(
    (next: (prev: WorldImportDraft) => WorldImportDraft) => {
      setDraft((prev) => (prev ? next(prev) : prev));
      setDirty(true);
    },
    [],
  );

  const editEntry = useCallback(
    (entryId: string, patch: EntryEditPatch) => {
      mutate((prev) => updateEntry(prev, entryId, patch));
    },
    [mutate],
  );

  const acceptAi = useCallback(
    (entryId: string) => {
      mutate((prev) => acceptAiInference(prev, entryId));
    },
    [mutate],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      mutate((prev) => deleteEntry(prev, entryId));
    },
    [mutate],
  );

  const resolveConflict = useCallback(
    (entryId: string, resolved: boolean) => {
      mutate((prev) => setConflictResolved(prev, entryId, resolved));
    },
    [mutate],
  );

  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    setSaving(true);
    try {
      const at = await store.save(current);
      setSavedAt(at);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [store]);

  const resetToFixture = useCallback(async () => {
    const current = draftRef.current;
    setResetting(true);
    try {
      if (current) {
        await store.clear(current.id);
      }
      await loadFrom({ preferSaved: false });
    } finally {
      setResetting(false);
    }
  }, [store, loadFrom]);

  return {
    loadState,
    draft,
    savedAt,
    dirty,
    saving,
    resetting,
    editEntry,
    acceptAi,
    removeEntry,
    resolveConflict,
    save,
    resetToFixture,
    reload: () => loadFrom({ preferSaved: true }),
  };
}
