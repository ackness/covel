import { randomUUID } from "node:crypto";
import type {
  LorebookEntryRecord,
  MediaStore,
  PluginDataRecord,
  StoreTransaction,
} from "@covel/store";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
  materializeMediaIndexWrites,
} from "./media-handling.js";
import { ledgerForWrite, valueHashForWrite } from "./ledger.js";
import { pluginWriteIdentity } from "./identity.js";
import type {
  ImportPlan,
  PlannedWrite,
  WorldDataImportedMediaRef,
} from "./types.js";
import { isRecord } from "./utils.js";
import { lorebookPosition, lorebookStrategy } from "./validation.js";

async function existingKeySet(options: {
  store: StoreTransaction;
  sessionId: string;
  writes: readonly PlannedWrite[];
}): Promise<ReadonlySet<string>> {
  const existing = new Set<string>();
  for (const write of options.writes) {
    if (write.kind === "plugin-data" || write.kind === "media-index") {
      const record = await options.store.getPluginData(
        options.sessionId,
        write.pluginId,
        write.namespace,
        write.key,
      );
      if (record) existing.add(pluginWriteIdentity(write)!);
    } else if (write.kind === "lorebook") {
      const entries = await options.store.listSessionLorebookEntries(
        options.sessionId,
      );
      if (entries.some((entry) => entry.id === write.id)) {
        existing.add(pluginWriteIdentity(write)!);
      }
    } else if (write.kind === "character") {
      const characters = await options.store.listCharacters(options.sessionId);
      if (characters.some((character) => character.id === write.key)) {
        existing.add(pluginWriteIdentity(write)!);
      }
    }
  }
  return existing;
}

function toPluginDataRecord(
  sessionId: string,
  write: PlannedWrite & ({ kind: "plugin-data" } | { kind: "media-index" }),
  now: string,
): PluginDataRecord {
  return {
    id: randomUUID(),
    sessionId,
    pluginId: write.pluginId,
    namespace: write.namespace,
    key: write.key,
    value: write.value,
    createdAt: now,
    updatedAt: now,
  };
}

function lorebookRecordValue(write: PlannedWrite & { kind: "lorebook" }) {
  return isRecord(write.value) ? write.value : { content: write.content };
}

function toLorebookRecord(
  sessionId: string,
  write: PlannedWrite & { kind: "lorebook" },
  insertionOrder: number,
  now: string,
): LorebookEntryRecord {
  const value = lorebookRecordValue(write);
  return {
    id: write.id,
    sessionId,
    pluginId: write.pluginId,
    keys: Array.isArray(value.keys)
      ? value.keys.filter((key): key is string => typeof key === "string")
      : [],
    content: write.content,
    strategy: lorebookStrategy(value),
    position: lorebookPosition(value),
    insertionOrder:
      typeof value.insertionOrder === "number"
        ? value.insertionOrder
        : insertionOrder,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    ...(value.extra !== undefined ? { extra: value.extra } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export async function writeImportPlan(options: {
  store: StoreTransaction;
  mediaStore?: MediaStore;
  sessionId: string;
  worldId: string;
  now: string;
  plan: ImportPlan;
  deferMediaFinalize?: boolean;
}): Promise<{
  written: number;
  skipped: number;
  mediaRefs: readonly WorldDataImportedMediaRef[];
}> {
  if (
    options.plan.diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    throw new Error(
      `invalid worldData import plan for "${options.worldId}": ${options.plan.diagnostics
        .filter((diagnostic) => diagnostic.level === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  const existing = await existingKeySet({
    store: options.store,
    sessionId: options.sessionId,
    writes: options.plan.writes,
  });
  const seen = new Set<string>();
  const selected: PlannedWrite[] = [];
  let skipped = 0;
  for (const write of options.plan.writes) {
    const identity = pluginWriteIdentity(write);
    if (
      write.source.descriptor.merge === "skipExisting" &&
      identity &&
      (seen.has(identity) || existing.has(identity))
    ) {
      skipped++;
      continue;
    }
    if (identity) seen.add(identity);
    selected.push(write);
  }

  let materialized:
    Awaited<ReturnType<typeof materializeMediaIndexWrites>> | undefined;
  // Compensation stack filled as each media asset lands, so a failure PART
  // WAY THROUGH materialization is still cleanable. `materialized` is only
  // assigned on full success, so relying on it alone leaked every asset put
  // before the throw.
  const putMediaRefs: WorldDataImportedMediaRef[] = [];
  try {
    materialized = await materializeMediaIndexWrites({
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      writes: selected,
      onMediaRef: (ref) => putMediaRefs.push(ref),
    });
    const materializedWrites = materialized.writes;

    const pluginWrites = materializedWrites.filter(
      (
        write,
      ): write is PlannedWrite &
        ({ kind: "plugin-data" } | { kind: "media-index" }) =>
        write.kind === "plugin-data" || write.kind === "media-index",
    );
    const pluginRecords = pluginWrites.map((write) =>
      toPluginDataRecord(options.sessionId, write, options.now),
    );
    if (pluginRecords.length > 0) {
      await options.store.setPluginDataBatch(pluginRecords);
    }

    const lorebookEntries = materializedWrites
      .filter(
        (write): write is PlannedWrite & { kind: "lorebook" } =>
          write.kind === "lorebook",
      )
      .map((write, index) => ({
        write,
        record: toLorebookRecord(
          options.sessionId,
          write,
          500 + index * 100,
          options.now,
        ),
      }));
    const lorebookRecords = lorebookEntries.map((entry) => entry.record);
    if (lorebookRecords.length > 0) {
      await options.store.upsertLorebookEntries(lorebookRecords);
    }

    for (const write of materializedWrites) {
      if (write.kind === "character") {
        await options.store.upsertCharacter(write.record);
      }
    }

    const lorebookRecordById = new Map(
      lorebookEntries.map((entry) => [entry.write.id, entry.record]),
    );
    const ledger = materializedWrites.map((write) => {
      const lorebookRecord =
        write.kind === "lorebook"
          ? lorebookRecordById.get(write.id)
          : undefined;
      return ledgerForWrite({
        sessionId: options.sessionId,
        worldId: options.worldId,
        write,
        now: options.now,
        valueHash: valueHashForWrite({
          sessionId: options.sessionId,
          write,
          lorebookRecord,
        }),
      });
    });
    await options.store.saveWorldDataImportLedgerBatch?.(ledger);
    if (!options.deferMediaFinalize) {
      await finalizeWorldDataMediaRefs({
        mediaStore: options.mediaStore,
        refs: materialized.mediaRefs,
      });
    }

    return {
      written: materializedWrites.length,
      skipped,
      mediaRefs: materialized.mediaRefs,
    };
  } catch (err) {
    await cleanupWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: materialized?.mediaRefs ?? putMediaRefs,
    });
    throw err;
  }
}
