import {
  appendDimensionPlan,
  readEffectiveDimensions,
} from "./session-import/dimensions.js";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSettlementReceiptSchema,
  dimensionsJsonEqual,
} from "@covel/shared";
import { portableContractSources } from "./portable-contract-data.js";
import type { WorldDataImportLedgerRecord } from "@covel/store";
import {
  conventionsOfPlugins,
  worldHasData,
  type ConventionalSource,
} from "./conventions.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import {
  finalizeWorldDataMediaRefs,
  materializeMediaIndexWrites,
  releaseWorldDataMediaRefs,
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

/**
 * The conventions of the plugins this import runs with. A caller that gives
 * a registry gets the paths of that registry; without one the list of the
 * process applies.
 */
function conventionsFor(
  deps: WorldDataImportPreflightDeps | undefined,
): readonly ConventionalSource[] | undefined {
  return deps?.registry ? conventionsOfPlugins(deps.registry) : undefined;
}

export { finalizeWorldDataMediaRefs, releaseWorldDataMediaRefs };

export type {
  ImportWorldDataForSessionResult,
  PreparedWorldDataImport,
  PreparedWorldDataSync,
  PreflightWorldDataForSessionResult,
  SyncWorldDataForSessionResult,
  WorldDataImportedMediaRef,
};

export async function prepareWorldDataImportForSession(
  options: PrepareWorldDataImportForSessionOptions,
): Promise<PreparedWorldDataImport> {
  if (!options.worldId) return { imported: false, diagnostics: [] };
  const worldRoot = options.worldsDirs?.length
    ? await resolveWorldRoot(options.worldId, options.worldsDirs)
    : null;
  const manifest = worldRoot ? await readWorldManifest(worldRoot) : null;
  const effectiveDimensions = worldRoot
    ? await readEffectiveDimensions({
        worldRoot,
        manifest: manifest!,
        locale: options.locale,
      })
    : options.dimensions;
  if (
    !worldRoot ||
    !manifest ||
    !(await worldHasData(
      worldRoot,
      manifest.worldData,
      conventionsFor(options.preflight),
    ))
  ) {
    const sources = portableContractSources(options.contractData);
    if (options.contractData === undefined && effectiveDimensions === undefined)
      return { imported: false, diagnostics: [] };
    const basePlan = await buildImportPlan({
      sessionId: options.sessionId,
      worldId: options.worldId,
      sources,
      deps: options.preflight,
      now: options.now,
      locale: options.locale,
    });
    const plan = appendDimensionPlan(
      basePlan,
      effectiveDimensions,
      options.preflight,
      options.locale,
    );
    return {
      imported: true,
      portableOnly: true,
      diagnostics: [...plan.diagnostics, ...plan.mergeEvents],
      plan,
      mediaRefs: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
    conventions: conventionsFor(options.preflight),
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

  const basePlan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: options.preflight,
    now: options.now,
    locale: options.locale,
  });
  const resolvedDimensions = await readEffectiveDimensions({
    worldRoot,
    manifest: manifest!,
    sources: descriptor.sources,
    locale: options.locale,
  });
  const plan = appendDimensionPlan(
    basePlan,
    resolvedDimensions,
    options.preflight,
    options.locale,
  );
  const mediaRefs: WorldDataImportedMediaRef[] = [];
  let materializedWrites = plan.writes;
  if (options.mediaStore) {
    const materialized = await materializeMediaIndexWrites({
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      writes: plan.writes,
    });
    mediaRefs.push(...materialized.mediaRefs);
    materializedWrites = materialized.writes;
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
  const mediaRefs = [...options.prepared.mediaRefs];
  let result: Awaited<ReturnType<typeof writeImportPlan>>;
  try {
    result = await writeImportPlan({
      store: options.store,
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      worldId: options.worldId,
      now: options.now,
      plan: options.prepared.plan,
      deferMediaFinalize: true,
    });
    mediaRefs.push(...result.mediaRefs);
  } catch (error) {
    await releaseWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
    throw error;
  }
  if (!options.deferMediaFinalize) {
    await finalizeWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
  }
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
    (!options.preflight?.activePlugins || options.locale === undefined) &&
    options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const prepared = await prepareWorldDataImportForSession({
    dimensions: options.worldId
      ? (await options.store.getWorld(options.worldId))?.metadata?.dimensions
      : undefined,
    contractData: options.worldId
      ? (await options.store.getWorld(options.worldId))?.metadata?.contractData
      : undefined,
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
    const prepared = await prepareWorldDataImportForSession({
      ...options,
      worldsDirs: [],
      preflight: { ...options.preflight, executeProjectionHandlers: false },
    });
    return prepared.imported
      ? preflightPlanResult(prepared.plan, prepared.diagnostics)
      : {
          imported: false,
          diagnostics: prepared.diagnostics,
          planned: 0,
          targets: [],
        };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    const prepared = await prepareWorldDataImportForSession({
      ...options,
      worldsDirs: [],
      preflight: { ...options.preflight, executeProjectionHandlers: false },
    });
    return prepared.imported
      ? preflightPlanResult(prepared.plan, prepared.diagnostics)
      : {
          imported: false,
          diagnostics: prepared.diagnostics,
          planned: 0,
          targets: [],
        };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (
    !(await worldHasData(
      worldRoot,
      manifest.worldData,
      conventionsFor(options.preflight),
    ))
  ) {
    const prepared = await prepareWorldDataImportForSession({
      ...options,
      worldsDirs: [],
      preflight: { ...options.preflight, executeProjectionHandlers: false },
    });
    return prepared.imported
      ? preflightPlanResult(prepared.plan, prepared.diagnostics)
      : {
          imported: false,
          diagnostics: prepared.diagnostics,
          planned: 0,
          targets: [],
        };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
    conventions: conventionsFor(options.preflight),
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

  const basePlan = await buildImportPlan({
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

  const plan = basePlan.diagnostics.some((item) => item.level === "error")
    ? basePlan
    : appendDimensionPlan(
        basePlan,
        await readEffectiveDimensions({
          worldRoot,
          manifest,
          sources: descriptor.sources,
          locale: options.locale,
        }),
        options.preflight,
        options.locale,
      );
  return preflightPlanResult(plan, [
    ...descriptor.diagnostics,
    ...plan.diagnostics,
    ...plan.mergeEvents,
  ]);
}

function preflightPlanResult(
  plan: PreparedWorldDataSync["plan"],
  diagnostics: PreparedWorldDataSync["diagnostics"],
): PreflightWorldDataForSessionResult {
  return {
    imported: true,
    diagnostics,
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
    return preparePortableWorldDataSync(options);
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return preparePortableWorldDataSync(options);
  }
  const manifest = await readWorldManifest(worldRoot);
  if (
    !(await worldHasData(
      worldRoot,
      manifest.worldData,
      conventionsFor(options.preflight),
    ))
  ) {
    const session = await options.store.getSession(options.sessionId);
    const definitions = await readEffectiveDimensions({
      worldRoot,
      manifest,
      locale: options.locale ?? session?.locale,
    });
    const plan = appendDimensionPlan(
      emptyImportPlan(),
      definitions,
      {
        ...options.preflight,
        activePlugins:
          options.preflight?.activePlugins ?? session?.activePlugins,
      },
      options.locale ?? session?.locale,
    );
    // There is no descriptor for other domains: do not treat their old ledger
    // rows as removed merely because inline dimensions are now synchronizable.
    return {
      imported: true,
      dimensionOnly: true,
      diagnostics: [...plan.diagnostics, ...plan.mergeEvents],
      plan,
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
    conventions: conventionsFor(options.preflight),
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

  if (options.dimensionOnly) {
    const session = await options.store.getSession(options.sessionId);
    const definitions = await readEffectiveDimensions({
      worldRoot,
      manifest,
      sources: descriptor.sources,
      locale: options.locale ?? session?.locale,
    });
    const plan = appendDimensionPlan(
      emptyImportPlan(),
      definitions,
      {
        ...options.preflight,
        activePlugins:
          options.preflight?.activePlugins ?? session?.activePlugins,
      },
      options.locale ?? session?.locale,
    );
    return {
      imported: true,
      dimensionOnly: true,
      diagnostics: [
        ...descriptor.diagnostics,
        ...plan.diagnostics,
        ...plan.mergeEvents,
      ],
      plan,
    };
  }

  const session =
    (!options.preflight?.activePlugins || options.locale === undefined) &&
    options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const basePlan = await buildImportPlan({
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
  const effectiveDimensions = await readEffectiveDimensions({
    worldRoot,
    manifest,
    sources: descriptor.sources,
    locale: options.locale ?? session?.locale,
  });
  const plan = appendDimensionPlan(
    basePlan,
    effectiveDimensions,
    {
      ...options.preflight,
      activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
    },
    options.locale ?? session?.locale,
  );
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

async function preparePortableWorldDataSync(
  options: SyncWorldDataForSessionOptions,
): Promise<PreparedWorldDataSync> {
  const session =
    !options.preflight?.activePlugins || options.locale === undefined
      ? await options.store.getSession(options.sessionId)
      : null;
  const prepared = await prepareWorldDataImportForSession({
    sessionId: options.sessionId,
    worldId: options.worldId,
    now: options.now,
    locale: options.locale ?? session?.locale,
    dimensions: options.worldId
      ? (await options.store.getWorld(options.worldId))?.metadata?.dimensions
      : undefined,
    contractData: options.worldId
      ? (await options.store.getWorld(options.worldId))?.metadata?.contractData
      : undefined,
    preflight: {
      ...options.preflight,
      activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
    },
  });
  return prepared.imported
    ? { imported: true, diagnostics: prepared.diagnostics, plan: prepared.plan }
    : {
        imported: false,
        diagnostics: prepared.diagnostics,
        plan: emptyImportPlan(),
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

  const dimensionOnly = options.dimensionOnly || prepared.dimensionOnly;
  const selectedWrites = dimensionOnly
    ? plan.writes.filter(
        (write) =>
          write.kind === "plugin-data" &&
          write.namespace === DIMENSION_DATA_NAMESPACE,
      )
    : plan.writes;
  const ledgers = (
    await options.store.listWorldDataImportLedger(options.sessionId)
  ).filter(
    (ledger) =>
      ledger.managed &&
      ledger.sourceWorldId === worldId &&
      (!dimensionOnly || ledger.namespace === DIMENSION_DATA_NAMESPACE),
  );
  const ledgerByKey = new Map(
    ledgers.map((ledger) => [ledgerKey(ledger), ledger]),
  );
  const writesByKey = new Map(
    selectedWrites.map((write) => [writeKey(write), write]),
  );
  // A pending settlement froze the definitions it will be judged against, so
  // it protects every dimension of its provider. The provider is whoever holds
  // the data: the one the session bound, the owner of an import ledger row, or
  // the target of a planned write. Dimensions committed via
  // `dimension.initialize` have no ledger row and still have an owner.
  const dimensionProviders = new Set<string>();
  const boundProvider = (await options.store.getSession(options.sessionId))
    ?.metadata?._dimensionProviderPluginId;
  if (typeof boundProvider === "string") dimensionProviders.add(boundProvider);
  for (const ledger of ledgers)
    if (ledger.namespace === DIMENSION_DATA_NAMESPACE && ledger.pluginId)
      dimensionProviders.add(ledger.pluginId);
  for (const write of plan.writes)
    if (
      write.kind === "plugin-data" &&
      write.namespace === DIMENSION_DATA_NAMESPACE
    )
      dimensionProviders.add(write.pluginId);
  let pendingDimensions = false;
  for (const provider of dimensionProviders) {
    const receipts = await options.store.listPluginData(
      options.sessionId,
      provider,
      DIMENSION_SETTLEMENT_NAMESPACE,
    );
    pendingDimensions ||= receipts.some(
      (row) =>
        dimensionSettlementReceiptSchema.parse(row.value).status ===
        "pending-settlement",
    );
  }

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
    if (
      (ledger.namespace === DIMENSION_DATA_NAMESPACE && pendingDimensions) ||
      (currentHash !== ledger.valueHash &&
        (!options.force || ledger.namespace === DIMENSION_DATA_NAMESPACE))
    ) {
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
      // Dimensions committed via `dimension.initialize` carry no import ledger
      // row. If the live record already evolved or was hand-edited, re-import
      // must surface a conflict instead of silently resetting it to
      // initialValue.
      if (
        write.kind === "plugin-data" &&
        write.namespace === DIMENSION_DATA_NAMESPACE
      ) {
        const row = await options.store.getPluginData(
          options.sessionId,
          write.pluginId,
          DIMENSION_DATA_NAMESPACE,
          write.key,
        );
        const record = row ? dimensionRecordSchema.parse(row.value) : undefined;
        const evolved =
          record !== undefined &&
          (record.lastTrackedSource !== undefined ||
            !dimensionsJsonEqual(record.value, record.definition.initialValue));
        // An unchanged declaration keeps the record a pending settlement
        // froze; a changed one would replace it under that settlement.
        const incoming = dimensionRecordSchema.safeParse(write.value);
        const redefinedWhilePending =
          record !== undefined &&
          pendingDimensions &&
          !(
            incoming.success &&
            dimensionsJsonEqual(record.definition, incoming.data.definition)
          );
        if (evolved || redefinedWhilePending) {
          conflicts.push({
            target: `plugin-data:${write.pluginId}:${write.namespace}`,
            key: write.key,
            sourceId: write.source.id,
            reason: "modified",
          });
          continue;
        }
      }
      writesToApply.push(write);
      upserted++;
      continue;
    }
    if (
      ledger.namespace === DIMENSION_DATA_NAMESPACE &&
      write.sourceDigest === ledger.sourceDigest
    ) {
      unchanged++;
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
    if (
      (ledger.namespace === DIMENSION_DATA_NAMESPACE && pendingDimensions) ||
      (currentHash !== ledger.valueHash &&
        (!options.force || ledger.namespace === DIMENSION_DATA_NAMESPACE))
    ) {
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
  // Drop references only after the semantic transaction commits.
  const pendingMediaUnrefs: string[] = [];
  const materialized = await materializeMediaIndexWrites({
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    writes: writesToApply,
  });
  mediaRefs.push(...materialized.mediaRefs);
  const materializedWritesToApply = materialized.writes;
  let committed = false;
  try {
    // Scoped transaction: ledger deletes + plan writes commit atomically and a
    // throw rolls back the DB. Unclaimed materialized bytes remain for media GC.
    await options.store.withTransaction(async (tx) => {
      // Compare-and-swap. The conflict scan above ran BEFORE this transaction
      // opened, so anything it declared unmodified could have been edited in
      // between — by a turn, or by another HTTP writer — and a `force: false`
      // sync would then silently overwrite that edit. Re-read each target's
      // hash inside the transaction and abort the whole thing if it moved.
      // The caller's session lock closes the turn-interleave window; this
      // closes the rest.
      for (const provider of dimensionProviders) {
        await tx.compareAndSetPluginDataBatch(options.sessionId, provider, []);
        // The scan found no pending settlement; one registered since then
        // protects its dimensions from this sync as well.
        const settlementRegistered =
          !pendingDimensions &&
          (
            await tx.listPluginData(
              options.sessionId,
              provider,
              DIMENSION_SETTLEMENT_NAMESPACE,
            )
          ).some(
            (row) =>
              dimensionSettlementReceiptSchema.parse(row.value).status ===
              "pending-settlement",
          );
        if (settlementRegistered)
          throw new WorldDataSyncConflictError(
            "world-data sync aborted: a dimension settlement became pending after the conflict check",
          );
      }
      {
        for (const ledger of ledgersToDelete) {
          if (options.force && ledger.namespace !== DIMENSION_DATA_NAMESPACE)
            continue;
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
        if (!(
          ledger.namespace === DIMENSION_DATA_NAMESPACE &&
          writesByKey.has(ledgerKey(ledger))
        ))
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

    committed = true;
    // Release references after commit. Ownership/bytes remain for lifecycle GC;
    // content-addressed media can be claimed by another session concurrently.
    if (options.mediaStore && pendingMediaUnrefs.length > 0) {
      for (const mediaId of pendingMediaUnrefs) {
        try {
          await options.mediaStore.removeRef(mediaId, options.sessionId);
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
  } finally {
    // A committed index must stay pinned if permanent claims could not be saved.
    if (!committed)
      await releaseWorldDataMediaRefs({
        mediaStore: options.mediaStore,
        refs: mediaRefs,
      });
  }
}
