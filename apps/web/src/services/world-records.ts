import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { WorldRecord } from "./api.js";
import { getDataService } from "./data-service.js";

/**
 * Full world records (lore, dimensions, metadata), fetched when a screen reads
 * them. The world list and the session store hold summaries only.
 *
 * One entry per world ID, shared by every reader. Whatever refreshes the list
 * or changes, installs, updates or deletes a world calls
 * {@link invalidateWorldRecord} (or the all-worlds form) so the next read
 * fetches again.
 */

interface Entry {
  readonly promise: Promise<WorldRecord | null>;
  /** Set once the fetch resolved; `undefined` while it is in flight. */
  value?: WorldRecord | null;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Start (or join) the fetch of one world's full record. */
export function loadWorldRecord(id: string): Promise<WorldRecord | null> {
  const existing = entries.get(id);
  if (existing) return existing.promise;
  const entry: Entry = {
    promise: getDataService()
      .getWorld(id)
      .then(
        (world) => {
          // An invalidation while the fetch was in flight drops its result.
          if (entries.get(id) === entry) entry.value = world;
          return world;
        },
        (error: unknown) => {
          if (entries.get(id) === entry) entries.delete(id);
          throw error;
        },
      ),
  };
  entries.set(id, entry);
  return entry.promise;
}

/** The cached record, `undefined` while it has not been fetched. */
export function peekWorldRecord(id: string): WorldRecord | null | undefined {
  return entries.get(id)?.value;
}

/** Store a record that was just fetched in full, for readers that mount later. */
export function primeWorldRecord(world: WorldRecord): void {
  entries.set(world.id, {
    promise: Promise.resolve(world),
    value: world,
  });
  notify();
}

/** Forget one world's record; mounted readers fetch it again. */
export function invalidateWorldRecord(id: string): void {
  if (entries.delete(id)) notify();
}

/** Forget every record, after the list was fetched again. */
export function invalidateAllWorldRecords(): void {
  if (entries.size === 0) return;
  entries.clear();
  notify();
}

export interface WorldRecordState {
  /** The full record; the previous one while a refresh is under way. */
  readonly world: WorldRecord | null;
  readonly status: "loading" | "ready" | "missing" | "error";
  readonly retry: () => void;
}

/**
 * The full record of a world, fetched on first use. A screen paints from the
 * summary it already has and reads the large fields from here.
 */
export function useWorldRecord(id: string | undefined): WorldRecordState {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [failed, setFailed] = useState<{ id: string; attempt: number } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const last = useRef<WorldRecord | null>(null);

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  const cached = id ? peekWorldRecord(id) : undefined;
  useEffect(() => {
    if (!id || cached !== undefined) return;
    let live = true;
    loadWorldRecord(id).then(
      () => {
        if (live) rerender();
      },
      () => {
        if (live) setFailed({ id, attempt });
      },
    );
    return () => {
      live = false;
    };
  }, [id, cached, attempt]);

  if (cached) last.current = cached;
  else if (last.current?.id !== id) last.current = null;

  const retry = useCallback(() => {
    // A world that read as missing is looked up again too.
    if (id) entries.delete(id);
    setFailed(null);
    setAttempt((n) => n + 1);
  }, [id]);

  const world = cached ?? last.current;
  const status: WorldRecordState["status"] =
    cached === null
      ? "missing"
      : cached
        ? "ready"
        : failed && failed.id === id && failed.attempt === attempt
          ? "error"
          : "loading";
  return { world, status, retry };
}
