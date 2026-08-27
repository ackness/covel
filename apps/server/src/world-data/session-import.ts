import type { WorldDataImportLedgerRecord } from "@covel/store";
import { loadWorldDataDescriptor } from "./descriptor.js";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
  materializeMediaIndexWrites,
  maybeDeleteOwnedUnreferencedMedia,
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
  ApplyPreparedWorldDataImportForSessionOptions,
  PrepareWorldDataImportForSessionOptions,
  PreparedWorldDataImport,
  PreparedWorldDataSync,
  PlannedWrite,
  PreflightWorldDataForSessionOptions,
  PreflightWorldDataForSessionResult,
  SyncWorldDataForSessionOptions,
  SyncWorldDataForSessionResult,
  WorldDataImportedMediaRef,
  WorldDataImportPreflightDeps,
} from "./session-import/types.js";

function deferredProjectionLedgerKey(
  ledger: WorldDataImportLedgerRecord,
): string | null {
  const projection = ledger.derivedFrom?.find((item) =>
    item.startsWith("projection:"),
  );
  const output = ledger.derivedFrom?.find((item) => item.startsWith("output:"));
  if (!projection || !output) return null;
  return `${ledger.sourceId}\u0000${projection.slice("projection:".length)}\u0000${output.slice("output:".length)}`;
}

export { cleanupWorldDataMediaRefs, finalizeWorldDataMediaRefs };

export type {
  ImportWorldDataForSessionResult,
  PreparedWorldDataImport,
  PreparedWorldDataSync,
  PreflightWorldDataForSessionResult,
  SyncWorldDataForSessionResult,
  WorldDataImportedMediaRef,
  WorldDataImportPreflightDeps,
};

export async function prepareWorldDataImportForSession(
  options: PrepareWorldDataImportForSessionOptions,
): Promise<PreparedWorldDataImport> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      diagnostics: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      diagnostics: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      diagnostics: [],
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

  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: options.preflight,
    now: options.now,
    locale: options.locale,
  });
  const mediaRefs: WorldDataImportedMediaRef[] = [];
  let materializedWrites = plan.writes;
  if (options.mediaStore) {
    try {
      const materialized = await materializeMediaIndexWrites({
        mediaStore: options.mediaStore,
        sessionId: options.sessionId,
        writes: plan.writes,
        onMediaRef: (ref) => mediaRefs.push(ref),
      });
      materializedWrites = materialized.writes;
    } catch (error) {
      await cleanupWorldDataMediaRefs({
        mediaStore: options.mediaStore,
        refs: mediaRefs,
      });
      throw error;
    }
  }
  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    plan: {
      ...plan,
      writes: materializedWrites,
    },
    mediaRefs,
  };
}

export async function applyPreparedWorldDataImportForSession(
  options: ApplyPreparedWorldDataImportForSessionOptions,
): Promise<ImportWorldDataForSessionResult> {
  if (!options.prepared.imported || !options.worldId) {
    return {
      imported: false,
      diagnostics: options.prepared.diagnostics,
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }
  let result: Awaited<ReturnType<typeof writeImportPlan>>;
  try {
    result = await writeImportPlan({
      store: options.store,
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      worldId: options.worldId,
      now: options.now,
      plan: options.prepared.plan,
      deferMediaFinalize: options.deferMediaFinalize,
    });
  } catch (error) {
    await cleanupWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: options.prepared.mediaRefs,
    });
    throw error;
  }
  if (!options.deferMediaFinalize && options.prepared.mediaRefs.length > 0) {
    await finalizeWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: options.prepared.mediaRefs,
    });
  }
  const mediaRefs = [...options.prepared.mediaRefs, ...result.mediaRefs];

  return {
    imported: true,
    diagnostics: options.prepared.diagnostics,
    planned: options.prepared.plan.writes.length,
    written: result.written,
    skipped: result.skipped,
    mediaRefs,
  };
}

export async function importWorldDataForSession(
  options: ImportWorldDataForSessionOptions,
): Promise<ImportWorldDataForSessionResult> {
  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const prepared = await prepareWorldDataImportForSession({
    sessionId: options.sessionId,
    worldId: options.worldId,
    worldsDirs: options.worldsDirs,
    covelHome: options.covelHome,
    now: options.now,
    // Keep the compatibility helper's historical DB/media ordering. Session
    // creation passes mediaStore explicitly and gets the transaction-shortened
    // path; callers importing into an existing session may need skipExisting
    // selection before materialization.
    preflight: {
      ...options.preflight,
      activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
    },
    locale: options.locale ?? session?.locale,
  });
  return applyPreparedWorldDataImportForSession({
    store: options.store,
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    worldId: options.worldId,
    now: options.now,
    prepared,
    deferMediaFinalize: options.deferMediaFinalize,
  });
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
    deps: {
      ...options.preflight,
      // A preflight endpoint is observational: importing arbitrary plugin
      // modules here would execute side effects while claiming to be read-only.
      executeProjectionHandlers: false,
    },
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

function emptyImportPlan(): PreparedWorldDataSync["plan"] {
  return {
    writes: [],
    diagnostics: [],
    mergeEvents: [],
    deferredProjectionOutputs: [],
  };
}

/**
 * Read world files, validate schemas, and execute approved projections without
 * holding a session mutation lock. The returned in-process plan is immutable
 * input to the short conflict-scan/apply barrier in `syncWorldDataForSession`.
 */
export async function prepareWorldDataSyncForSession(
  options: SyncWorldDataForSessionOptions,
): Promise<PreparedWorldDataSync> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return { imported: false, diagnostics: [], plan: emptyImportPlan() };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return { imported: false, diagnostics: [], plan: emptyImportPlan() };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return { imported: false, diagnostics: [], plan: emptyImportPlan() };
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
      plan: emptyImportPlan(),
    };
  }

  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: {
      ...options.preflight,
      activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
    },
    now: options.now,
    locale: options.locale ?? session?.locale,
  });
  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    plan,
  };
}

export async function syncWorldDataForSession(
  options: SyncWorldDataForSessionOptions,
): Promise<SyncWorldDataForSessionResult> {
  const dryRun = options.dryRun === true;
  const prepared =
    options.prepared ?? (await prepareWorldDataSyncForSession(options));
  const { diagnostics, plan } = prepared;
  if (
    !prepared.imported ||
    !options.worldId ||
    diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    return {
      imported: prepared.imported,
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
  // Capture the narrowed worldId so it stays `string` in transaction closures.
  const worldId = options.worldId;

  const ledgers = (
    await options.store.listWorldDataImportLedger(options.sessionId)
  ).filter((ledger) => ledger.managed && ledger.sourceWorldId === worldId);
  const ledgerByKey = new Map(
    ledgers.map((ledger) => [ledgerKey(ledger), ledger]),
  );
  const writesByKey = new Map(
    plan.writes.map((write) => [writeKey(write), write]),
  );
  const deferredProjectionKeys = new Set(
    plan.deferredProjectionOutputs.map(
      (output) =>
        `${output.sourceId}\u0000${output.pluginId}/${output.projectionId}\u0000${output.outputId}`,
    ),
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
    const deferredKey = deferredProjectionLedgerKey(ledger);
    if (deferredKey && deferredProjectionKeys.has(deferredKey)) {
      // Missing writes are non-authoritative while their producer is
      // deferred. Preserve both the target and ledger; a later successful
      // empty output is what authorizes deletion.
      unchanged++;
      continue;
    }
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
  // Media ids unreferenced by ledger deletes inside the transaction. Their
  // removeRef + owned-media delete (which does an irreversible rmSync) is
  // finalized only AFTER commit — the mirror of the put-side deferral — so a
  // mid-transaction abort rolls back the DB rows without having deleted a file
  // the restored rows still point at.
  const pendingMediaUnrefs: string[] = [];
  let materializedWritesToApply: readonly PlannedWrite[] = writesToApply;
  try {
    const materialized = await materializeMediaIndexWrites({
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      writes: writesToApply,
      onMediaRef: (ref) => mediaRefs.push(ref),
    });
    materializedWritesToApply = materialized.writes;

    // Scoped transaction: ledger deletes + plan writes commit atomically and a
    // throw auto-rolls-back the DB. `mediaRefs` is collected on the outer array
    // so the catch below can still clean up media written before the failure
    // (media files live outside the DB transaction).
    await options.store.withTransaction(async (tx) => {
      // Compare-and-swap. The conflict scan above ran BEFORE this transaction
      // opened, so anything it declared unmodified could have been edited in
      // between — by a turn, or by another HTTP writer — and a `force: false`
      // sync would then silently overwrite that edit. Re-read each target's
      // hash inside the transaction and abort the whole thing if it moved.
      // The caller's session lock closes the turn-interleave window; this
      // closes the rest.
      if (!options.force) {
        for (const ledger of ledgersToDelete) {
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
          sessionId: options.sessionId,
          ledger,
          onMediaUnref: (mediaId) => pendingMediaUnrefs.push(mediaId),
        });
        await tx.deleteWorldDataImportLedger(options.sessionId, ledger.id);
      }
      if (materializedWritesToApply.length > 0) {
        const writeResult = await writeImportPlan({
          store: tx,
          // Media-index writes were materialized above, before opening the DB
          // transaction. Keeping this undefined guards against future write
          // shapes accidentally performing filesystem I/O in the transaction.
          mediaStore: undefined,
          sessionId: options.sessionId,
          worldId,
          now: options.now,
          plan: {
            writes: materializedWritesToApply,
            diagnostics: [],
            mergeEvents: [],
            deferredProjectionOutputs: [],
          },
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

  // The transaction committed. Only now delete the media unreferenced by the
  // ledger deletes: removeRef drops the ref row, and an owned asset with no
  // remaining refs is deleted (files and all). A failure here leaks a ref/asset
  // (a GC concern) rather than stranding a committed reference on a missing
  // file, so each is best-effort and independent.
  if (options.mediaStore && pendingMediaUnrefs.length > 0) {
    for (const mediaId of pendingMediaUnrefs) {
      try {
        await options.mediaStore.removeRef(mediaId, options.sessionId);
        await maybeDeleteOwnedUnreferencedMedia({
          mediaStore: options.mediaStore,
          mediaId,
          sessionId: options.sessionId,
        });
      } catch {
        // Continue finalizing the remaining unrefs.
      }
    }
  }

  if (mediaRefs.length > 0) {
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
