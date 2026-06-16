/**
 * Shared serialization gateway + small helpers for the canonical row→record
 * mappers.
 *
 * Both the PostgreSQL and SQLite backends select drizzle rows whose column
 * names already match the camelCase record fields. The ONLY structural
 * difference between them is how JSON columns are read:
 *
 *  - PostgreSQL `jsonb` columns arrive already deserialized as JS values.
 *  - SQLite `text` columns arrive as JSON strings that must be parsed.
 *
 * Each mapper takes a {@link JsonReader} so the per-backend modules only have
 * to supply that thin serialization gateway. The mappers are otherwise a
 * single canonical definition shared across both SQL backends.
 *
 * `read` mirrors the legacy "optional JSON" behaviour (PG `?? undefined`,
 * SQLite `fromJson`) and `readRequired` mirrors the "required JSON" behaviour
 * (PG `?? null`, SQLite `fromJsonRequired`).
 */

/**
 * Per-backend JSON deserialization gateway injected into the canonical
 * mappers.
 */
export interface JsonReader {
  /** Optional JSON column → value or `undefined` when absent. */
  read(raw: unknown): unknown;
  /** Required JSON column → value or `null` when absent. */
  readRequired(raw: unknown): unknown;
}

/** `managed`/`enabled` come back as `0|1` (SQLite) or boolean (PG). */
export function asBoolean(value: number | boolean): boolean {
  return value !== 0 && value !== false;
}
