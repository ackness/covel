/**
 * Backend-agnostic canonical row→record mappers (barrel).
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
 * The mappers are split by domain under `./mappers/` (matching the `records/`
 * domain layout); this module re-exports them so existing importers keep a
 * single, stable entry point.
 */

export type { JsonReader } from "./mappers/json-reader.js";
export { asBoolean } from "./mappers/json-reader.js";

export * from "./mappers/session-mappers.js";
export * from "./mappers/world-mappers.js";
export * from "./mappers/runtime-mappers.js";
export * from "./mappers/state-mappers.js";
export * from "./mappers/plugin-mappers.js";
export * from "./mappers/memory-mappers.js";
export * from "./mappers/snapshot-mappers.js";
export * from "./mappers/lifecycle-mappers.js";
