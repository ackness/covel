import {
  DIMENSION_DATA_NAMESPACE,
  dimensionRecordSchema,
  dimensionsJsonEqual,
  validateWorldModel,
} from "@covel/shared";
import { createWorldModelView } from "@covel/runtime";
import { randomUUID } from "node:crypto";
import type {
  LorebookEntryRecord,
  MediaStore,
  PluginDataRecord,
  StoreTransaction,
} from "@covel/store";
import {
  finalizeWorldDataMediaRefs,
  materializeMediaIndexWrites,
  releaseWorldDataMediaRefs,
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
      if (
        entries.some(
          (entry) => entry.owner.kind === "world" && entry.id === write.id,
        )
      ) {
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

/**
 * The entry's `extra`, with the record's own title. The prompt names a world
 * rule by `extra.title`; without it the model reads the rule's id or its
 * first trigger keyword in place of the title.
 */
function lorebookExtra(value: Record<string, unknown>): unknown {
  const title = value.title;
  if (typeof title !== "string" || title.length === 0) return value.extra;
  if (value.extra === undefined) return { title };
  if (!isRecord(value.extra) || typeof value.extra.title === "string")
    return value.extra;
  return { ...value.extra, title };
}

function toLorebookRecord(
  sessionId: string,
  write: PlannedWrite & { kind: "lorebook" },
  insertionOrder: number,
  now: string,
): LorebookEntryRecord {
  const value = lorebookRecordValue(write);
  const extra = lorebookExtra(value);
  return {
    id: write.id,
    sessionId,
    owner: { kind: "world" },
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
    ...(extra !== undefined ? { extra } : {}),
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

  const materialized = await materializeMediaIndexWrites({
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    writes: selected,
  });
  try {
    const materializedWrites = [...materialized.writes];
    const dimensionWrites = materializedWrites.filter(
      (write) =>
        write.kind === "plugin-data" &&
        write.namespace === DIMENSION_DATA_NAMESPACE,
    );
    const providerIds = new Set(
      dimensionWrites.map((write) =>
        "pluginId" in write ? write.pluginId : "",
      ),
    );
    if (providerIds.size > 1)
      throw new Error("Conflicting dimension import providers");
    const provider = [...providerIds][0];
    if (provider) {
      const session = await options.store.getSession(options.sessionId);
      const bound = session?.metadata?._dimensionProviderPluginId;
      if (bound !== undefined && bound !== provider)
        throw new Error("Dimension provider changed");
      const entries = [];
      for (const write of dimensionWrites) {
        if (write.kind !== "plugin-data") continue;
        const row = await options.store.getPluginData(
          options.sessionId,
          provider,
          DIMENSION_DATA_NAMESPACE,
          write.key,
        );
        const before = row ? dimensionRecordSchema.parse(row.value) : undefined;
        const incoming = dimensionRecordSchema.parse(write.value);
        const value = {
          ...incoming,
          version: before
            ? before.version +
              (dimensionsJsonEqual(before.definition, incoming.definition)
                ? 0
                : 1)
            : 1,
        };
        if (
          before &&
          dimensionsJsonEqual(before.definition, incoming.definition)
        ) {
          if (!dimensionsJsonEqual(before.value, incoming.value))
            throw new Error(`Dimension already evolved: ${write.key}`);
        }
        const index = materializedWrites.indexOf(write);
        materializedWrites[index] = { ...write, value };
        entries.push({
          namespace: DIMENSION_DATA_NAMESPACE,
          key: write.key,
          expectedVersion: before?.version ?? null,
          value,
          timestamp: options.now,
        });
      }
      if (
        !(await options.store.compareAndSetPluginDataBatch(
          options.sessionId,
          provider,
          entries,
        ))
      )
        throw new Error("Dimension import version conflict");
      // Bind the provider only AFTER the dimension rows committed — a failed
      // CAS must not leave a bound provider with zero dimension rows, which
      // would deadlock the settlement barrier on the next narrative.
      await options.store.updateSession(options.sessionId, {
        metadata: { _dimensionProviderPluginId: provider },
      });
    }

    const pluginWrites = materializedWrites.filter(
      (
        write,
      ): write is PlannedWrite &
        ({ kind: "plugin-data" } | { kind: "media-index" }) =>
        (write.kind === "plugin-data" &&
          write.namespace !== DIMENSION_DATA_NAMESPACE) ||
        write.kind === "media-index",
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

    const characterWrites = materializedWrites.filter(
      (write): write is PlannedWrite & { kind: "character" } =>
        write.kind === "character",
    );
    if (characterWrites.length > 0) {
      const view = await createWorldModelView(options.store, options.sessionId);
      const merged = new Map(
        view.characters.map((record) => [record.id, record]),
      );
      for (const write of characterWrites)
        merged.set(write.record.id, write.record);
      validateWorldModel({ ...view, characters: [...merged.values()] });
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
  } catch (error) {
    await releaseWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: materialized.mediaRefs,
    });
    throw error;
  }
  if (!options.deferMediaFinalize) {
    await finalizeWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: materialized.mediaRefs,
    });
  }

  return {
    written: materialized.writes.length,
    skipped,
    mediaRefs: materialized.mediaRefs,
  };
}
