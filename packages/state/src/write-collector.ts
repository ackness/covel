/**
 * Write collector — accumulates state writes during a turn, detects conflicts at commit.
 */

import type { WriteConflict, WriteConflictEntry } from "@covel/shared";

export interface PendingWrite {
  readonly table: string;
  readonly field: string;
  readonly newValue: unknown;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly priority: number;
  readonly reason?: string;
}

export interface CommitResult {
  readonly committed: readonly PendingWrite[];
  readonly conflicts: readonly WriteConflict[];
}

export interface WriteCollector {
  /** Record a pending write (not yet committed). */
  recordWrite(write: PendingWrite): void;
  /** Get all pending writes. */
  getPendingWrites(): readonly PendingWrite[];
  /** Detect conflicts and return committed writes + conflicts. */
  commit(): CommitResult;
  /** Clear all pending writes. */
  clear(): void;
}

export function createWriteCollector(): WriteCollector {
  let pending: PendingWrite[] = [];

  return {
    recordWrite(write) {
      pending = [...pending, write];
    },

    getPendingWrites() {
      return [...pending];
    },

    commit() {
      // Group by table:field
      const groups = new Map<string, PendingWrite[]>();
      for (const write of pending) {
        const key = `${write.table}:${write.field}`;
        const group = groups.get(key);
        if (group) {
          groups.set(key, [...group, write]);
        } else {
          groups.set(key, [write]);
        }
      }

      const committed: PendingWrite[] = [];
      const conflicts: WriteConflict[] = [];

      for (const [, writes] of groups) {
        // Check if all values are the same
        const firstValue = writes[0]!.newValue;
        const allSame = writes.every((w) => w.newValue === firstValue);

        if (allSame) {
          // Deduplicate: commit only the first write
          committed.push(writes[0]!);
        } else {
          // Conflict: different values for same field
          const conflictEntries: WriteConflictEntry[] = writes.map((w) => ({
            runtimeId: w.runtimeId,
            pluginId: w.pluginId,
            priority: w.priority,
            newValue: w.newValue,
            reason: w.reason,
          }));

          conflicts.push({
            table: writes[0]!.table,
            field: writes[0]!.field,
            originalValue: undefined,
            writes: conflictEntries,
          });
        }
      }

      return { committed, conflicts };
    },

    clear() {
      pending = [];
    },
  };
}
