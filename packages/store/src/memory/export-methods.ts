/**
 * MemoryStore runtime-export methods (the `output.recordAs` publications).
 *
 * The collection is a `Map` keyed by the record's composite unique key
 * (sessionId, producerRuntimeId, recordAs, revision), so an append is idempotent
 * — a present key returns `false` without overwriting, mirroring the SQL unique
 * index. The record has no optional fields, so there is nothing to canonicalise:
 * a `value` of top-level `null` is stored (and read) verbatim, matching the SQL
 * backends' nullable-column-read-as-`null` semantics for a required field.
 */

import type { RuntimeExportRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

// Map keys are JSON-serialised composite-key tuples — collision-free regardless
// of identifier contents (no separator character to clash with).
function exportKey(r: RuntimeExportRecord): string {
  return JSON.stringify([
    r.sessionId,
    r.producerRuntimeId,
    r.recordAs,
    r.revision,
  ]);
}

export function createExportMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async appendRuntimeExport(record: RuntimeExportRecord) {
      const key = exportKey(record);
      if (state.runtimeExports.has(key)) return false;
      state.runtimeExports.set(key, record);
      return true;
    },

    async getLatestRuntimeExport(
      sessionId: string,
      producerRuntimeId: string,
      recordAs: string,
      opts?: { readonly atOrBefore?: string },
    ) {
      let latest: RuntimeExportRecord | null = null;
      for (const r of state.runtimeExports.values()) {
        if (
          r.sessionId !== sessionId ||
          r.producerRuntimeId !== producerRuntimeId ||
          r.recordAs !== recordAs
        ) {
          continue;
        }
        if (opts?.atOrBefore !== undefined && r.committedAt > opts.atOrBefore) {
          continue;
        }
        if (latest === null || r.revision > latest.revision) latest = r;
      }
      return latest;
    },

    async listRuntimeExports(
      sessionId: string,
      filter?: {
        readonly producerRuntimeId?: string;
        readonly recordAs?: string;
      },
    ) {
      return [...state.runtimeExports.values()]
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            (filter?.producerRuntimeId === undefined ||
              r.producerRuntimeId === filter.producerRuntimeId) &&
            (filter?.recordAs === undefined || r.recordAs === filter.recordAs),
        )
        .sort(
          (a, b) =>
            a.producerRuntimeId.localeCompare(b.producerRuntimeId) ||
            a.recordAs.localeCompare(b.recordAs) ||
            a.revision - b.revision,
        );
    },
  };
}
