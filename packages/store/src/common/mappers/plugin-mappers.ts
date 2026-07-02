/**
 * Backend-agnostic canonical row→record mappers for the plugin domain
 * (plugin data, trace events).
 */

import type { PluginDataRecord, TraceEventRecord } from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface PluginDataRow {
  id: string;
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TraceEventRow {
  id: string;
  sessionId: string;
  type: string;
  traceId: string;
  turnId: string;
  payload: unknown;
  createdAt: string;
}

export function toPluginDataRecord(
  row: PluginDataRow,
  json: JsonReader,
): PluginDataRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    // Required JSON: a stored `null` value must round-trip as `null`
    // (not `undefined`) on both PG and SQLite.
    value: json.readRequired(row.value),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTraceEventRecord(
  row: TraceEventRow,
  json: JsonReader,
): TraceEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    traceId: row.traceId,
    turnId: row.turnId,
    payload: json.read(row.payload),
    createdAt: row.createdAt,
  };
}
