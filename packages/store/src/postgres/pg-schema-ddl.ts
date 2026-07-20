/**
 * PostgreSQL boot DDL.
 *
 * Table + index DDL is DERIVED from the Drizzle schema (`./schema.ts`) — the
 * single source of truth — via {@link buildCreateTablesSql}. There is no longer
 * a hand-maintained copy of the column/index definitions here.
 *
 * Only the things Drizzle cannot model stay hand-written below, because they are
 * operational, not a second copy of the schema:
 *   - idempotent `sessions` column migrations for pre-existing databases;
 *   - the `vector_models` table-name backfill function + trigger.
 *
 * Media tables are emitted into their own constant ({@link CREATE_MEDIA_TABLES_SQL})
 * because the MediaStore boots them standalone (`media-store/pg.ts`).
 *
 * The schema↔DDL parity guard lives in `tests/schema-index-consistency.test.ts`
 * and `tests/schema-ddl-codegen.test.ts`.
 */

import { buildCreateTablesSql, tableNameOf } from "../common/ddl-codegen.js";
import {
  SESSIONS_TABLE,
  SESSION_SCOPED_TABLE_NAMES,
} from "../table-registry.js";
import * as schema from "./schema.js";

// ── Table partition: media tables boot standalone for the MediaStore ────

const MEDIA_TABLE_NAMES = new Set(["media_assets", "media_refs"]);

function isMediaTable(table: unknown): boolean {
  try {
    return MEDIA_TABLE_NAMES.has(tableNameOf(table));
  } catch {
    return false;
  }
}

const allTables = Object.values(schema);
const coreTables = allTables.filter((t) => !isMediaTable(t));
const mediaTables = allTables.filter((t) => isMediaTable(t));

/**
 * media_assets + media_refs DDL. Booted standalone by `media-store/pg.ts`, and
 * also appended to {@link CREATE_TABLES_SQL} for the full store.
 *
 * media_refs note: the UNIQUE constraint is on (session_id, media_id) only —
 * plugin_id is "first-source metadata" but does NOT participate in the key.
 * PostgreSQL (like SQLite) treats each NULL as distinct in a UNIQUE column,
 * which made an earlier (session_id, media_id, plugin_id) constraint silently
 * allow unbounded duplicate rows when callers passed undefined / NULL pluginId.
 * addRef() is idempotent per (session_id, media_id). Sites with legacy duplicate
 * rows must dedupe before this index can be created. See docs/reference/media-store.md.
 */
export const CREATE_MEDIA_TABLES_SQL = buildCreateTablesSql(mediaTables, "pg");

const CREATE_CORE_TABLES_SQL = buildCreateTablesSql(coreTables, "pg");

/**
 * T3 (turn-band refactor) + later additions: bring databases created by an
 * earlier schema up to date. Every statement is idempotent (`IF [NOT] EXISTS`),
 * so this is safe to run on every boot, fresh or legacy.
 */
const SESSIONS_MIGRATIONS_SQL = `
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pre_game_completed JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE sessions DROP COLUMN IF EXISTS phase;
  ALTER TABLE sessions DROP COLUMN IF EXISTS playing_turn_offset;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_model_overrides JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB;
  ALTER TABLE turn_results ADD COLUMN IF NOT EXISTS origin TEXT;
  ALTER TABLE turn_results ADD COLUMN IF NOT EXISTS parent_turn_id TEXT;
`;

/**
 * BEFORE INSERT trigger: PG evaluates SERIAL defaults before BEFORE INSERT
 * triggers fire, so NEW.id is already populated. We mutate NEW.table_name in
 * place — no separate UPDATE statement needed. Drizzle does not model triggers,
 * so this is hand-written.
 */
const VECTOR_MODELS_TRIGGER_SQL = `
  CREATE OR REPLACE FUNCTION vector_models_fill_table_name() RETURNS TRIGGER AS $fn$
  BEGIN
    IF NEW.table_name IS NULL OR NEW.table_name = '' THEN
      NEW.table_name := 'vec_mem_m' || NEW.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS vector_models_fill_table_name_trigger ON vector_models;
  CREATE TRIGGER vector_models_fill_table_name_trigger
    BEFORE INSERT ON vector_models
    FOR EACH ROW
    EXECUTE FUNCTION vector_models_fill_table_name();
`;

export const CREATE_TABLES_SQL = [
  CREATE_CORE_TABLES_SQL,
  SESSIONS_MIGRATIONS_SQL,
  VECTOR_MODELS_TRIGGER_SQL,
  CREATE_MEDIA_TABLES_SQL,
].join("\n\n");

// ── Table names for cleanup ─────────────────────────────────────

// Session-scoped child tables come from the single-source registry; the
// non-session tables (worlds, media) are listed explicitly. Adding a session
// table to the registry extends the DROP list automatically.
export const ALL_TABLE_NAMES: readonly string[] = [
  "worlds",
  SESSIONS_TABLE,
  ...SESSION_SCOPED_TABLE_NAMES,
  "media_refs",
  "media_assets",
];

export const DROP_ALL_SQL = ALL_TABLE_NAMES.map(
  (t) => `DROP TABLE IF EXISTS ${t} CASCADE;`,
).join("\n");
