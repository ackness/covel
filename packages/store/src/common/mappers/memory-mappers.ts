import { parseLorebookOwnerKey } from "../lorebook-owner.js";
/**
 * Backend-agnostic canonical row→record mappers for the memory domain
 * (turn messages, player inputs, working memory, world-data import ledger,
 * lorebook entries, session summaries).
 */

import type {
  LorebookEntryRecord,
  PlayerInputRecord,
  SessionSummaryRecord,
  TurnMessageRecord,
  WorldDataImportLedgerRecord,
} from "../../types.js";
import { asBoolean, type JsonReader } from "./json-reader.js";

export interface TurnMessageRow {
  id: string;
  sessionId: string;
  turnId: string;
  sourceType: string;
  sourcePluginId: string | null;
  sourceRuntimeId: string | null;
  role: string;
  name: string | null;
  content: string;
  ui: unknown;
  pendingInput: unknown;
  order: number;
  createdAt: string;
  compactedAtTurnId: string | null;
}

export interface PlayerInputRow {
  id: string;
  sessionId: string;
  turnId: string;
  formId: string;
  values: unknown;
  createdAt: string;
}

export interface WorldDataLedgerRow {
  id: string;
  sessionId: string;
  target: string;
  pluginId: string | null;
  namespace: string | null;
  key: string | null;
  sourceWorldId: string;
  sourceId: string;
  sourceDigest: string;
  valueHash: string;
  schemaRef: string | null;
  derivedFrom: unknown;
  importedAt: string;
  managed: number | boolean;
}

export interface LorebookEntryRow {
  id: string;
  sessionId: string;
  owner: string;
  keys: unknown;
  content: string;
  strategy: string;
  position: string;
  insertionOrder: number;
  enabled: number | boolean;
  extra: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryRow {
  id: string;
  sessionId: string;
  turnRangeStart: string;
  turnRangeEnd: string;
  content: string;
  focusSections: unknown;
  createdAt: string;
}

export function toTurnMessageRecord(
  row: TurnMessageRow,
  json: JsonReader,
): TurnMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    sourceType: row.sourceType,
    sourcePluginId: row.sourcePluginId ?? undefined,
    sourceRuntimeId: row.sourceRuntimeId ?? undefined,
    role: row.role,
    name: row.name ?? undefined,
    content: row.content,
    ui: json.read(row.ui),
    pendingInput: json.read(row.pendingInput),
    order: row.order,
    createdAt: row.createdAt,
    compactedAtTurnId: row.compactedAtTurnId ?? undefined,
  };
}

export function toPlayerInputRecord(
  row: PlayerInputRow,
  json: JsonReader,
): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: json.readRequired(row.values),
    createdAt: row.createdAt,
  };
}

export function toWorldDataImportLedgerRecord(
  row: WorldDataLedgerRow,
  json: JsonReader,
): WorldDataImportLedgerRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    target: row.target,
    pluginId: row.pluginId ?? undefined,
    namespace: row.namespace ?? undefined,
    key: row.key ?? undefined,
    sourceWorldId: row.sourceWorldId,
    sourceId: row.sourceId,
    sourceDigest: row.sourceDigest,
    valueHash: row.valueHash,
    schemaRef: row.schemaRef ?? undefined,
    derivedFrom:
      row.derivedFrom == null
        ? undefined
        : ((json.readRequired(row.derivedFrom) as string[] | null) ?? []),
    importedAt: row.importedAt,
    managed: asBoolean(row.managed),
  };
}

export function toLorebookEntryRecord(
  row: LorebookEntryRow,
  json: JsonReader,
): LorebookEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    owner: parseLorebookOwnerKey(row.owner),
    keys: ((json.readRequired(row.keys) as string[] | null) ??
      []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord["strategy"],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: asBoolean(row.enabled),
    extra: row.extra == null ? undefined : json.readRequired(row.extra),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSessionSummaryRecord(
  row: SessionSummaryRow,
  json: JsonReader,
): SessionSummaryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnRangeStart: row.turnRangeStart,
    turnRangeEnd: row.turnRangeEnd,
    content: row.content,
    focusSections:
      (json.readRequired(row.focusSections) as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
}
