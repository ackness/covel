/**
 * Backend-agnostic canonical row→record mappers for the state domain
 * (state schemas/entries/changes, events, approvals, messages, characters).
 */

import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  MessageRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
} from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface StateSchemaRow {
  id: string;
  sessionId: string;
  tableName: string;
  schema: unknown;
  createdAt: string;
}

export interface StateEntryRow {
  id: string;
  sessionId: string;
  tableName: string;
  fieldName: string;
  value: unknown;
  updatedAt: string;
}

export interface StateChangeRow {
  id: string;
  sessionId: string;
  tableName: string;
  fieldName: string;
  value: unknown;
  changedBy: string;
  turnId: string;
  reason: string | null;
  createdAt: string;
}

export interface EventRow {
  id: string;
  sessionId: string;
  type: string;
  topic: string;
  payload: unknown;
  targetRuntime: string | null;
  turnId: string | null;
  createdAt: string;
}

export interface ApprovalRow {
  id: string;
  sessionId: string;
  toolName: string;
  pluginId: string;
  decision: string;
  turnId: string;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: string;
}

export interface CharacterRow {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  description: string | null;
  fields: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toStateSchemaRecord(
  row: StateSchemaRow,
  json: JsonReader,
): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: json.readRequired(row.schema),
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(
  row: StateEntryRow,
  json: JsonReader,
): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: json.read(row.value),
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(
  row: StateChangeRow,
  json: JsonReader,
): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: json.read(row.value),
    changedBy: row.changedBy,
    turnId: row.turnId,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toEventRecord(row: EventRow, json: JsonReader): EventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    topic: row.topic,
    payload: json.read(row.payload),
    targetRuntime: row.targetRuntime ?? undefined,
    turnId: row.turnId ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    decision: row.decision,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

export function toMessageRecord(
  row: MessageRow,
  json: JsonReader,
): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: json.read(row.metadata),
    createdAt: row.createdAt,
  };
}

export function toCharacterRecord(
  row: CharacterRow,
  json: JsonReader,
): CharacterRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    type: row.type,
    description: row.description ?? undefined,
    fields: json.read(row.fields),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
