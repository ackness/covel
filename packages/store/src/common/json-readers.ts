/**
 * {@link JsonReader} instances for the SQL backends.
 *
 * The canonical mappers in `./mappers.ts` are agnostic to how a JSON column is
 * stored; these readers are the only place that difference lives.
 */

import { fromJson, fromJsonRequired } from "../sqlite/sqlite-json.js";
import type { JsonReader } from "./mappers.js";

/**
 * PostgreSQL `jsonb` columns are already deserialized by the driver. The only
 * normalisation needed is collapsing `null`:
 *  - optional reads return `undefined` when the value is `null`/absent;
 *  - required reads return `null` when the value is `null`/absent.
 */
export const pgJsonReader: JsonReader = {
  read: (raw) => raw ?? undefined,
  readRequired: (raw) => raw ?? null,
};

/**
 * SQLite stores JSON columns as text, so values must be parsed. `fromJson`
 * yields `undefined` on null/parse-failure (optional), `fromJsonRequired`
 * yields `null` (required) — matching the historical mapper behaviour.
 */
export const sqliteJsonReader: JsonReader = {
  read: (raw) => fromJson(raw as string | null | undefined),
  readRequired: (raw) => fromJsonRequired(raw as string | null | undefined),
};
