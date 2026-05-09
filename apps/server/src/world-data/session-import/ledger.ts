import { randomUUID } from "node:crypto";
import type {
  CharacterRecord,
  DataStore,
  LorebookEntryRecord,
  MediaStore,
  WorldDataImportLedgerRecord,
} from "@covel/store";
import { canonicalJson, sha256Hex } from "../digest.js";
import { maybeDeleteOwnedUnreferencedMedia } from "./media-handling.js";
import type { PlannedWrite, SyncWorldDataForSessionResult } from "./types.js";
import { isRecord } from "./utils.js";

function stableImportValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    typeof value.importedAt === "string" &&
    typeof value.sourceWorldId === "string" &&
    typeof value.sourceId === "string"
  ) {
    const { importedAt: _importedAt, ...rest } = value;
    return rest;
  }
  return value;
}

function stableCharacterValue(record: CharacterRecord): unknown {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record;
  return rest;
}

function stableLorebookValue(record: LorebookEntryRecord): unknown {
  const {
    sessionId: _sessionId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = record;
  return rest;
}

function hashImportValue(value: unknown): string {
  return sha256Hex(canonicalJson(stableImportValue(value)));
}

export function ledgerForWrite(options: {
  sessionId: string;
  worldId: string;
  write: PlannedWrite;
  now: string;
  valueHash: string;
}): WorldDataImportLedgerRecord {
  const { write } = options;
  const key =
    write.kind === "plugin-data" || write.kind === "media-index"
      ? write.key
      : write.kind === "lorebook"
        ? write.id
        : write.key;
  return {
    id: randomUUID(),
    sessionId: options.sessionId,
    target: write.target,
    ...((write.kind === "plugin-data" || write.kind === "media-index") && {
      pluginId: write.pluginId,
      namespace: write.namespace,
    }),
    key,
    sourceWorldId: options.worldId,
    sourceId: write.source.id,
    sourceDigest: write.sourceDigest,
    valueHash: options.valueHash,
    ...(write.source.descriptor.schema
      ? { schemaRef: write.source.descriptor.schema }
      : {}),
    ...(write.derivedFrom ? { derivedFrom: write.derivedFrom } : {}),
    importedAt: options.now,
    managed: true,
  };
}

export function valueHashForWrite(options: {
  sessionId: string;
  write: PlannedWrite;
  lorebookRecord?: LorebookEntryRecord;
}): string {
  const { write } = options;
  if (write.kind === "character") {
    return sha256Hex(canonicalJson(stableCharacterValue(write.record)));
  }
  if (write.kind === "lorebook") {
    if (!options.lorebookRecord) {
      throw new Error("missing lorebook record for worldData ledger hash");
    }
    return sha256Hex(
      canonicalJson(stableLorebookValue(options.lorebookRecord)),
    );
  }
  return hashImportValue(write.value);
}

export function ledgerKey(ledger: WorldDataImportLedgerRecord): string {
  return `${ledger.target}:${ledger.pluginId ?? ""}:${ledger.namespace ?? ""}:${ledger.key ?? ""}`;
}

export async function currentHashForLedger(options: {
  store: DataStore;
  sessionId: string;
  ledger: WorldDataImportLedgerRecord;
}): Promise<string | null> {
  const { store, sessionId, ledger } = options;
  if (
    ledger.target.startsWith("plugin:") &&
    ledger.pluginId &&
    ledger.namespace &&
    ledger.key
  ) {
    const record = await store.getPluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    return record ? hashImportValue(record.value) : null;
  }
  if (ledger.target === "characters" && ledger.key) {
    const record = (await store.listCharacters(sessionId)).find(
      (character) => character.id === ledger.key,
    );
    return record
      ? sha256Hex(canonicalJson(stableCharacterValue(record)))
      : null;
  }
  if (ledger.key) {
    const record = (await store.listSessionLorebookEntries(sessionId)).find(
      (entry) => entry.id === ledger.key,
    );
    return record
      ? sha256Hex(canonicalJson(stableLorebookValue(record)))
      : null;
  }
  return null;
}

export async function deleteLedgerTarget(options: {
  store: DataStore;
  mediaStore?: MediaStore;
  sessionId: string;
  ledger: WorldDataImportLedgerRecord;
}): Promise<void> {
  const { store, sessionId, ledger } = options;
  if (
    ledger.target.startsWith("plugin:") &&
    ledger.pluginId &&
    ledger.namespace &&
    ledger.key
  ) {
    const existing = await store.getPluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    await store.deletePluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    if (options.mediaStore) {
      const ref =
        isRecord(existing?.value) && isRecord(existing.value.ref)
          ? existing.value.ref
          : undefined;
      const mediaId = typeof ref?.id === "string" ? ref.id : undefined;
      if (mediaId) {
        try {
          await options.mediaStore.removeRef(mediaId, sessionId);
          await maybeDeleteOwnedUnreferencedMedia({
            mediaStore: options.mediaStore,
            mediaId,
            sessionId,
          });
        } catch {
          // Data sync should continue deleting the remaining managed rows.
        }
      }
    }
    return;
  }
  if (ledger.target === "characters" && ledger.key) {
    await store.deleteCharacter(sessionId, ledger.key);
    return;
  }
  if (ledger.key) {
    await store.deleteLorebookEntry(sessionId, ledger.key);
  }
}

export function syncConflictForLedger(
  ledger: WorldDataImportLedgerRecord,
  reason: "modified" | "missing",
): SyncWorldDataForSessionResult["conflicts"][number] {
  return {
    target: ledger.target,
    ...(ledger.key ? { key: ledger.key } : {}),
    sourceId: ledger.sourceId,
    reason,
  };
}
