/**
 * IndexedDB runtime-export store (the `output.recordAs` publications).
 *
 * The object store uses a composite array keyPath (sessionId, producerRuntimeId,
 * recordAs, revision) as its primary key, which natively enforces the same
 * uniqueness the SQL unique index does — so an append-if-absent is a
 * `get(compositeKey)` then `put` (idempotent: a present key returns `false`).
 * The record has no optional fields, so it is stored verbatim (a top-level
 * `null` value round-trips as `null`). Reads walk the `sessionId` index and sort
 * in JS to match the SQL `ORDER BY`.
 */

import type { RuntimeExportRecord } from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbExportStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async appendRuntimeExport(record: RuntimeExportRecord): Promise<boolean> {
      await mutations.ensureStoreSnapshot("runtime_exports");
      const tx = db.transaction("runtime_exports", "readwrite");
      const existing = await tx.store.get([
        record.sessionId,
        record.producerRuntimeId,
        record.recordAs,
        record.revision,
      ]);
      if (existing) {
        await tx.done;
        return false;
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
      return true;
    },

    async getLatestRuntimeExport(
      sessionId: string,
      producerRuntimeId: string,
      recordAs: string,
      opts?: { readonly atOrBefore?: string },
    ): Promise<RuntimeExportRecord | null> {
      const rows = (await db.getAllFromIndex(
        "runtime_exports",
        "sessionId",
        sessionId,
      )) as RuntimeExportRecord[];
      let latest: RuntimeExportRecord | null = null;
      for (const r of rows) {
        if (
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
    ): Promise<readonly RuntimeExportRecord[]> {
      const rows = (await db.getAllFromIndex(
        "runtime_exports",
        "sessionId",
        sessionId,
      )) as RuntimeExportRecord[];
      return rows
        .filter(
          (r) =>
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
