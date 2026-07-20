import type { WorldDataImportLedgerRecord } from "@covel/store";
import { loadWorldDataDescriptor } from "./descriptor.js";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
} from "./session-import/media-handling.js";
import { buildImportPlan } from "./session-import/planning.js";
import {
  currentHashForLedger,
  deleteLedgerTarget,
  ledgerKey,
  syncConflictForLedger,
} from "./session-import/ledger.js";
import { readWorldManifest, resolveWorldRoot } from "./session-import/utils.js";
import { writeImportPlan } from "./session-import/writes.js";
import { writeKey } from "./session-import/identity.js";
import type {
  ImportWorldDataForSessionOptions,
  ImportWorldDataForSessionResult,
  PlannedWrite,
  PreflightWorldDataForSessionOptions,
  PreflightWorldDataForSessionResult,
  SyncWorldDataForSessionOptions,
  SyncWorldDataForSessionResult,
  WorldDataImportedMediaRef,
  WorldDataImportPreflightDeps,
} from "./session-import/types.js";

export { cleanupWorldDataMediaRefs, finalizeWorldDataMediaRefs };

export type {
  ImportWorldDataForSessionResult,
  PreflightWorldDataForSessionResult,
  SyncWorldDataForSessionResult,
  WorldDataImportedMediaRef,
  WorldDataImportPreflightDeps,
};

export async function importWorldDataForSession(
  options: ImportWorldDataForSessionOptions,
): Promise<ImportWorldDataForSessionResult> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  const descriptorErrors = descriptor.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (descriptorErrors.length > 0) {
    throw new Error(
      `invalid worldData descriptor for "${options.worldId}": ${descriptorErrors
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const preflight = {
    ...options.preflight,
    activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
  };
  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: preflight,
    now: options.now,
    locale: options.locale ?? session?.locale,
  });
  const result = await writeImportPlan({
    store: options.store,
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    worldId: options.worldId,
    now: options.now,
    plan,
    deferMediaFinalize: options.deferMediaFinalize,
  });

  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    planned: plan.writes.length,
    written: result.written,
    skipped: result.skipped,
    mediaRefs: result.mediaRefs,
  };
}

export async function preflightWorldDataForSession(
  options: PreflightWorldDataForSessionOptions,
): Promise<PreflightWorldDataForSessionResult> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  if (
    descriptor.diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    return {
      imported: true,
      diagnostics: descriptor.diagnostics,
      planned: 0,
      targets: [],
    };
  }

  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: options.preflight,
    now: options.now,
    locale: options.locale,
  });

  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    planned: plan.writes.length,
    targets: plan.writes.map((write) => ({
      kind: write.kind,
      target: write.target,
      sourceId: write.source.id,
      ...((write.kind === "plugin-data" || write.kind === "media-index") && {
        pluginId: write.pluginId,
        namespace: write.namespace,
        key: write.key,
      }),
      ...(write.kind === "lorebook" && {
        pluginId: write.pluginId,
        key: write.id,
      }),
      ...(write.kind === "character" && { key: write.key }),
    })),
  };
}

/**
 * Raised when a target's hash moved between the conflict scan and the apply
 * transaction. Surfaces as a 409 rather than a 500: the caller can re-run the
 * sync (the fresh scan will report the edit as a normal conflict) or pass
 * `force`.
 */
export class WorldDataSyncConflictError extends Error {
  readonly code = "world_data_sync_conflict";
}

export async function syncWorldDataForSession(
  options: SyncWorldDataForSessionOptions,
): Promise<SyncWorldDataForSessionResult> {
  const dryRun = options.dryRun === true;
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }
  // Capture the narrowed (non-undefined) worldId so it stays `string` inside
  // the nested `withTransaction` callback, where property narrowing is lost.
  const worldId = options.worldId;
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  const descriptorErrors = descriptor.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (descriptorErrors.length > 0) {
    return {
      imported: true,
      dryRun,
      diagnostics: descriptor.diagnostics,
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const preflight = {
    ...options.preflight,
    activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
  };
  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: preflight,
    now: options.now,
    locale: options.locale ?? session?.locale,
  });
  const diagnostics = [
    ...descriptor.diagnostics,
    ...plan.diagnostics,
    ...plan.mergeEvents,
  ];
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return {
      imported: true,
      dryRun,
      diagnostics,
      planned: plan.writes.length,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const ledgers = (
    await options.store.listWorldDataImportLedger(options.sessionId)
  ).filter(
    (ledger) => ledger.managed && ledger.sourceWorldId === options.worldId,
  );
  const ledgerByKey = new Map(
    ledgers.map((ledger) => [ledgerKey(ledger), ledger]),
  );
  const writesByKey = new Map(
    plan.writes.map((write) => [writeKey(write), write]),
  );
  const conflicts: Array<SyncWorldDataForSessionResult["conflicts"][number]> =
    [];
  let unchanged = 0;
  let upserted = 0;
  let deleted = 0;
  const writesToApply: PlannedWrite[] = [];
  const ledgersToDelete: WorldDataImportLedgerRecord[] = [];

  for (const ledger of ledgers) {
    if (writesByKey.has(ledgerKey(ledger))) continue;
    const currentHash = await currentHashForLedger({
      store: options.store,
      sessionId: options.sessionId,
      ledger,
    });
    if (currentHash === null) {
      ledgersToDelete.push(ledger);
      deleted++;
      continue;
    }
    if (currentHash !== ledger.valueHash && !options.force) {
      conflicts.push(syncConflictForLedger(ledger, "modified"));
      continue;
    }
    ledgersToDelete.push(ledger);
    deleted++;
  }

  for (const write of plan.writes) {
    const key = writeKey(write);
    const ledger = ledgerByKey.get(key);
    if (!ledger) {
      writesToApply.push(write);
      upserted++;
      continue;
    }
    const currentHash = await currentHashForLedger({
      store: options.store,
      sessionId: options.sessionId,
      ledger,
    });
    if (currentHash === null) {
      if (!options.force) {
        conflicts.push(syncConflictForLedger(ledger, "missing"));
        continue;
      }
      ledgersToDelete.push(ledger);
      writesToApply.push(write);
      upserted++;
      continue;
    }
    if (currentHash !== ledger.valueHash && !options.force) {
      conflicts.push(syncConflictForLedger(ledger, "modified"));
      continue;
    }
    if (write.sourceDigest === ledger.sourceDigest) {
      unchanged++;
      continue;
    }
    ledgersToDelete.push(ledger);
    writesToApply.push(write);
    upserted++;
  }

  if (dryRun || conflicts.length > 0) {
    return {
      imported: true,
      dryRun,
      diagnostics,
      planned: plan.writes.length,
      upserted,
      deleted,
      unchanged,
      conflicts,
      mediaRefs: [],
    };
  }

  const mediaRefs: WorldDataImportedMediaRef[] = [];
  try {
    // Scoped transaction: ledger deletes + plan writes commit atomically and a
    // throw auto-rolls-back the DB. `mediaRefs` is collected on the outer array
    // so the catch below can still clean up media written before the failure
    // (media files live outside the DB transaction).
    await options.store.withTransaction!(async (tx) => {
      // Compare-and-swap. The conflict scan above ran BEFORE this transaction
      // opened, so anything it declared unmodified could have been edited in
      // between — by a turn, or by another HTTP writer — and a `force: false`
      // sync would then silently overwrite that edit. Re-read each target's
      // hash inside the transaction and abort the whole thing if it moved.
      // The caller's session lock closes the turn-interleave window; this
      // closes the rest.
      if (!options.force) {
        for (const ledger of [...ledgersToDelete]) {
          const freshHash = await currentHashForLedger({
            store: tx,
            sessionId: options.sessionId,
            ledger,
          });
          // `null` means the target is already gone — deleting it is still the
          // right outcome, and the pre-scan reached the same conclusion.
          if (freshHash !== null && freshHash !== ledger.valueHash) {
            throw new WorldDataSyncConflictError(
              `world-data sync aborted: "${ledgerKey(ledger)}" changed after the conflict check`,
            );
          }
        }
      }

      for (const ledger of ledgersToDelete) {
        await deleteLedgerTarget({
          store: tx,
          mediaStore: options.mediaStore,
          sessionId: options.sessionId,
          ledger,
        });
        await tx.deleteWorldDataImportLedger(options.sessionId, ledger.id);
      }
      if (writesToApply.length > 0) {
        const writeResult = await writeImportPlan({
          store: tx,
          mediaStore: options.mediaStore,
          sessionId: options.sessionId,
          worldId,
          now: options.now,
          plan: { writes: writesToApply, diagnostics: [], mergeEvents: [] },
          deferMediaFinalize: options.deferMediaFinalize,
        });
        mediaRefs.push(...writeResult.mediaRefs);
      }
    });
  } catch (err) {
    await cleanupWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
    throw err;
  }

  if (options.deferMediaFinalize) {
    await finalizeWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
  }

  return {
    imported: true,
    dryRun,
    diagnostics,
    planned: plan.writes.length,
    upserted,
    deleted,
    unchanged,
    conflicts,
    mediaRefs,
  };
}
