/**
 * {@link JsonWriter} instances for the SQL backends.
 *
 * The value builders in `./insert-values.ts` are agnostic to how a JSON column
 * is serialized; these writers are the only place that difference lives.
 */

import { toJson } from "../sqlite/sqlite-json.js";
import type { JsonWriter } from "./insert-values.js";

/**
 * PostgreSQL `jsonb` columns take the raw JS value. JSON value columns keep
 * the historical `value ?? null` behaviour; nullable columns pass through.
 */
export const pgJsonWriter: JsonWriter = {
  writeJson: (value) => value ?? null,
  writeNullableJson: (value) => value ?? null,
};

/**
 * SQLite `text` columns take a JSON string. Value columns are always
 * stringified (`toJson` turns null/undefined into `"null"`); nullable columns
 * keep `null` when absent.
 */
export const sqliteJsonWriter: JsonWriter = {
  writeJson: (value) => toJson(value),
  writeNullableJson: (value) => (value == null ? null : toJson(value)),
};
