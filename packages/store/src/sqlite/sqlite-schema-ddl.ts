import type Database from "better-sqlite3";

export function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      lore TEXT,
      tags TEXT,
      locale TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      turn_count INTEGER NOT NULL DEFAULT 0,
      pre_game_completed TEXT NOT NULL DEFAULT '[]',
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      active_plugins TEXT NOT NULL DEFAULT '[]',
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      embedding_model_id INTEGER,
      embedding_locked_at TEXT,
      runtime_model_overrides TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS turn_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_results TEXT NOT NULL,
      conflicts TEXT,
      audit_result TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_results_session_id_idx ON turn_results(session_id);
    CREATE INDEX IF NOT EXISTS turn_results_turn_id_idx ON turn_results(turn_id);

    CREATE TABLE IF NOT EXISTS runtime_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      tool_calls TEXT,
      duration_ms INTEGER NOT NULL,
      token_usage TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_results_session_id_idx ON runtime_results(session_id);
    CREATE INDEX IF NOT EXISTS runtime_results_turn_id_idx ON runtime_results(turn_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      input TEXT,
      output TEXT,
      duration_ms INTEGER NOT NULL,
      approval_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_session_id_idx ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS tool_calls_turn_id_idx ON tool_calls(turn_id);

    CREATE TABLE IF NOT EXISTS state_schemas (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      schema TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_schemas_session_id_idx ON state_schemas(session_id);

    CREATE TABLE IF NOT EXISTS state_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      field_name TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_entries_session_id_idx ON state_entries(session_id);
    CREATE INDEX IF NOT EXISTS state_entries_composite_idx ON state_entries(session_id, table_name, field_name);
    CREATE UNIQUE INDEX IF NOT EXISTS state_entries_unique_idx ON state_entries(session_id, table_name, field_name);

    CREATE TABLE IF NOT EXISTS state_changes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      field_name TEXT NOT NULL,
      value TEXT,
      changed_by TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_changes_session_id_idx ON state_changes(session_id);
    CREATE INDEX IF NOT EXISTS state_changes_composite_idx ON state_changes(session_id, table_name, field_name);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload TEXT,
      target_runtime TEXT,
      turn_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id);
    CREATE INDEX IF NOT EXISTS events_topic_idx ON events(session_id, topic);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      plugin_id TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_session_id_idx ON approvals(session_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      fields TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS characters_session_id_idx ON characters(session_id);

    CREATE TABLE IF NOT EXISTS plugin_data (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, plugin_id, namespace, key)
    );
    CREATE INDEX IF NOT EXISTS plugin_data_session_id_idx ON plugin_data(session_id);

    CREATE TABLE IF NOT EXISTS world_data_import_ledger (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      target TEXT NOT NULL,
      plugin_id TEXT,
      namespace TEXT,
      key TEXT,
      source_world_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      value_hash TEXT NOT NULL,
      schema_ref TEXT,
      derived_from TEXT,
      imported_at TEXT NOT NULL,
      managed INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS world_data_import_ledger_session_id_idx ON world_data_import_ledger(session_id);
    CREATE INDEX IF NOT EXISTS world_data_import_ledger_source_idx ON world_data_import_ledger(session_id, source_world_id, source_id);

    CREATE TABLE IF NOT EXISTS plugin_configs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plugin_configs_session_id_idx ON plugin_configs(session_id);
    CREATE INDEX IF NOT EXISTS plugin_configs_composite_idx ON plugin_configs(session_id, plugin_id);

    CREATE TABLE IF NOT EXISTS trace_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trace_events_session_id_idx ON trace_events(session_id);

    -- Runtime Outputs (PR-1 translation layer)
    CREATE TABLE IF NOT EXISTS runtime_outputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_result_id TEXT,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      results TEXT NOT NULL,
      meta_data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_outputs_session_time_idx ON runtime_outputs(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS runtime_outputs_runtime_idx ON runtime_outputs(session_id, runtime_id);
    CREATE INDEX IF NOT EXISTS runtime_outputs_plugin_idx ON runtime_outputs(session_id, plugin_id);

    -- Interaction Records (PR-1 translation layer)
    CREATE TABLE IF NOT EXISTS interaction_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      target_plugin_id TEXT,
      target_runtime_id TEXT,
      payload TEXT NOT NULL,
      meta_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS interaction_records_session_time_idx ON interaction_records(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS interaction_records_type_idx ON interaction_records(session_id, type);

    CREATE TABLE IF NOT EXISTS turn_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_plugin_id TEXT,
      source_runtime_id TEXT,
      role TEXT NOT NULL,
      name TEXT,
      content TEXT NOT NULL,
      ui TEXT,
      pending_input TEXT,
      "order" INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      compacted_at_turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turn_messages_session ON turn_messages(session_id);

    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_range_start TEXT NOT NULL,
      turn_range_end TEXT NOT NULL,
      content TEXT NOT NULL,
      focus_sections TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);

    CREATE TABLE IF NOT EXISTS player_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      "values" TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_player_inputs_session ON player_inputs(session_id);

    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      value TEXT NOT NULL,
      schema_ref TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_session ON working_memory(session_id);

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      meta TEXT,
      owner_session_id TEXT,
      owner_plugin_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_assets_owner_idx ON media_assets(owner_session_id, owner_plugin_id);

    -- media_refs: cross-session/plugin asset references for fork & inherit.
    --
    -- The UNIQUE constraint is on (session_id, media_id) only — plugin_id is
    -- recorded as "first-source metadata" but does NOT participate in the
    -- key. Rationale: SQLite (and PostgreSQL) treat each NULL as distinct in
    -- a UNIQUE column, which made the previous (session_id, media_id,
    -- plugin_id) constraint silently allow unbounded duplicate rows when
    -- callers passed undefined / NULL pluginId. addRef() is idempotent per
    -- (session_id, media_id) and the first writer's plugin_id is preserved.
    --
    -- Fresh installs: the new UNIQUE below is created and the table starts
    -- correct. Existing databases keep any pre-existing UNIQUE
    -- (session_id, media_id, plugin_id) index — that older index is strictly
    -- looser than the new one, so the stricter constraint still wins. Sites
    -- with legacy duplicate rows (same session_id + media_id, different
    -- plugin_id) MUST run a one-off migration before this DDL succeeds:
    --   DELETE FROM media_refs a USING media_refs b
    --     WHERE a.rowid > b.rowid AND a.session_id = b.session_id AND a.media_id = b.media_id;
    -- See docs/reference/media-store.md for details.
    CREATE TABLE IF NOT EXISTS media_refs (
      session_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      plugin_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, media_id)
    );
    -- Standalone CREATE UNIQUE INDEX so existing SQLite databases (where
    -- CREATE TABLE IF NOT EXISTS is a no-op) also get the (session_id,
    -- media_id) constraint via plain re-boot. Sites with legacy duplicate
    -- rows must dedupe first; this index simply errors during creation,
    -- surfacing the migration requirement loudly instead of silently.
    CREATE UNIQUE INDEX IF NOT EXISTS media_refs_unique_session_media_idx
      ON media_refs(session_id, media_id);
    CREATE INDEX IF NOT EXISTS media_refs_session_id_idx ON media_refs(session_id);
    CREATE INDEX IF NOT EXISTS media_refs_media_id_idx ON media_refs(media_id);

    CREATE TABLE IF NOT EXISTS lorebook_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      keys TEXT NOT NULL,
      content TEXT NOT NULL,
      strategy TEXT NOT NULL,
      position TEXT NOT NULL,
      insertion_order INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      extra TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lorebook_entries_session ON lorebook_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_lorebook_entries_plugin ON lorebook_entries(session_id, plugin_id);

    CREATE TABLE IF NOT EXISTS state_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_state_snapshots_session ON state_snapshots(session_id);

    CREATE TABLE IF NOT EXISTS suspensions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      resume_schema TEXT NOT NULL,
      pending_continuation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suspensions_session ON suspensions(session_id);

    CREATE TABLE IF NOT EXISTS vector_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      -- Auto-filled by the trigger below from the row id. Application
      -- code MUST NOT specify this column on INSERT — the schema-side
      -- trigger derives it as 'vec_mem_m{id}' so the registry stays
      -- consistent without a placeholder + UPDATE roundtrip.
      table_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      UNIQUE (model_id, dim)
    );

    -- Atomic table_name backfill: SQLite AFTER INSERT triggers see the
    -- generated rowid via NEW.id. The UPDATE runs in the same implicit
    -- transaction as the INSERT, so readers always see a populated row.
    CREATE TRIGGER IF NOT EXISTS vector_models_fill_table_name
      AFTER INSERT ON vector_models
      FOR EACH ROW
      WHEN NEW.table_name = '' OR NEW.table_name IS NULL
    BEGIN
      UPDATE vector_models
         SET table_name = 'vec_mem_m' || NEW.id
       WHERE id = NEW.id;
    END;
  `);

  // Migrations: add columns to sessions if they don't already exist
  const sessionCols = sqlite
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(sessionCols.map((c) => c.name));
  if (!colNames.has("embedding_model_id")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN embedding_model_id INTEGER");
  }
  if (!colNames.has("embedding_locked_at")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN embedding_locked_at TEXT");
  }
  if (!colNames.has("runtime_model_overrides")) {
    sqlite.exec(
      "ALTER TABLE sessions ADD COLUMN runtime_model_overrides TEXT DEFAULT '{}'",
    );
  }
  if (!colNames.has("metadata")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN metadata TEXT");
  }
}
