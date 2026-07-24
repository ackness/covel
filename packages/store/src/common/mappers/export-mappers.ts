/**
 * Backend-agnostic canonical row→record mapper for runtime exports.
 *
 * Column names already match the camelCase record fields. `value` is the only
 * JSON column: a required `JsonValue` stored in a nullable column, read through
 * the injected {@link JsonReader}'s `readRequired` (PG `null` / SQLite `"null"`
 * → `null`), matching `state_entries.value`. Every other field is a plain
 * scalar, so there is nothing to canonicalise — the record has no optional
 * fields and Memory / IDB store it verbatim.
 */

import type { RuntimeExportRecord } from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface RuntimeExportRow {
  sessionId: string;
  producerPluginId: string;
  producerRuntimeId: string;
  recordAs: string;
  revision: number;
  pluginVersion: string;
  schemaDigest: string;
  resultId: string;
  value: unknown;
  committedAt: string;
}

export function toRuntimeExportRecord(
  row: RuntimeExportRow,
  json: JsonReader,
): RuntimeExportRecord {
  return {
    sessionId: row.sessionId,
    producerPluginId: row.producerPluginId,
    producerRuntimeId: row.producerRuntimeId,
    recordAs: row.recordAs,
    revision: row.revision,
    pluginVersion: row.pluginVersion,
    schemaDigest: row.schemaDigest,
    resultId: row.resultId,
    value: json.readRequired(row.value) as RuntimeExportRecord["value"],
    committedAt: row.committedAt,
  };
}
