/**
 * Backend-agnostic canonical row→record mappers for events, messages and characters.
 */

import type {
  CharacterRecord,
  EventRecord,
  MessageRecord,
} from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface EventRow {
  id: string;
  sessionId: string;
  type: string;
  topic: string;
  payload: unknown;
  turnId: string | null;
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
  aliases: unknown;
  type: string;
  description: string | null;
  fields: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toEventRecord(row: EventRow, json: JsonReader): EventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    topic: row.topic,
    payload: json.read(row.payload),
    turnId: row.turnId ?? undefined,
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
    aliases: json.read(row.aliases) as CharacterRecord["aliases"],
    type: row.type,
    description: row.description ?? undefined,
    fields: json.read(row.fields),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
