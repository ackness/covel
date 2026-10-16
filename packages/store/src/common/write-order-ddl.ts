/**
 * Triggers that number the writes of a session in the order they are saved.
 *
 * Drizzle does not model triggers, so they are hand-written here and executed
 * at boot after the tables exist (`sqlite-schema-ddl.ts`, `pg-schema-ddl.ts`).
 * Every write takes the next number of its session from
 * `session_write_counters`:
 *
 *  - a turn message stores it in `write_seq`, the cursor of incremental readers
 *    (`listTurnMessagesAfter`). `created_at` is taken while an execution runs,
 *    and a background execution can be saved after a later turn, so a cursor on
 *    `created_at` would step over it for good;
 *  - an insert, update or delete of a lorebook entry, character or plugin data
 *    row stores it in that record's `record_changes` row, which also keeps the
 *    deletions (`listRecordChanges`).
 *
 * The counter row is taken inside the writing statement and stays locked until
 * the transaction ends (SQLite has one writer at a time; PostgreSQL holds the
 * row lock of the upsert), so a later number is never visible before an earlier
 * one of the same session. Doing this in triggers covers every write path,
 * including bulk deletes, without each store method having to remember it.
 *
 * Deleting a session fires the change triggers of its rows. The registry lists
 * `record_changes` and `session_write_counters` after the tables they describe,
 * so the cascade removes what those triggers wrote.
 * ponytail: PG locks each session counter until commit; deletes fire per row and change keys stay until session deletion.
 * See the common/write-order-ddl.ts row in docs/internals/technical-debt.md.
 */

/** A table whose changes `record_changes` keeps, and the identity it records. */
interface ChangeSource {
  readonly table: string;
  readonly kind: "lorebook" | "character" | "plugin_data";
  /** Column of the plugin ID, or null for an empty string. */
  readonly pluginId: string | null;
  /** Column of the namespace (the owner key for a lorebook entry), or null. */
  readonly namespace: string | null;
  readonly key: string;
}

const RECORD_CHANGE_SOURCES: readonly ChangeSource[] = [
  {
    table: "lorebook_entries",
    kind: "lorebook",
    pluginId: null,
    namespace: "owner",
    key: "id",
  },
  {
    table: "characters",
    kind: "character",
    pluginId: null,
    namespace: null,
    key: "id",
  },
  {
    table: "plugin_data",
    kind: "plugin_data",
    pluginId: "plugin_id",
    namespace: "namespace",
    key: "key",
  },
];

function identity(source: ChangeSource, row: "NEW" | "OLD"): string {
  const column = (name: string | null) => (name ? `${row}.${name}` : "''");
  return [
    `${row}.session_id`,
    `'${source.kind}'`,
    column(source.pluginId),
    column(source.namespace),
    `${row}.${source.key}`,
  ].join(", ");
}

const SQLITE_NEXT_WRITE = (row: "NEW" | "OLD") => `
    INSERT INTO session_write_counters (session_id, value)
      VALUES (${row}.session_id, 1)
      ON CONFLICT (session_id) DO UPDATE SET value = value + 1;`;

const SQLITE_CURRENT_WRITE = (row: "NEW" | "OLD") =>
  `(SELECT value FROM session_write_counters WHERE session_id = ${row}.session_id)`;

/** SQLite: the AFTER triggers that number turn messages and record changes. */
export function sqliteWriteOrderTriggersSql(): string {
  const turnMessages = `
  CREATE TRIGGER IF NOT EXISTS turn_messages_write_seq
    AFTER INSERT ON turn_messages
    FOR EACH ROW
  BEGIN${SQLITE_NEXT_WRITE("NEW")}
    UPDATE turn_messages SET write_seq = ${SQLITE_CURRENT_WRITE("NEW")}
      WHERE id = NEW.id;
  END;`;
  const changes = RECORD_CHANGE_SOURCES.flatMap((source) =>
    (
      [
        ["insert", "INSERT", "NEW"],
        ["update", "UPDATE", "NEW"],
        ["delete", "DELETE", "OLD"],
      ] as const
    ).map(
      ([suffix, event, row]) => `
  CREATE TRIGGER IF NOT EXISTS ${source.table}_record_change_${suffix}
    AFTER ${event} ON ${source.table}
    FOR EACH ROW
  BEGIN${SQLITE_NEXT_WRITE(row)}
    INSERT INTO record_changes (session_id, kind, plugin_id, namespace, key, seq)
      VALUES (${identity(source, row)}, ${SQLITE_CURRENT_WRITE(row)})
      ON CONFLICT (session_id, kind, plugin_id, namespace, key)
      DO UPDATE SET seq = excluded.seq;
  END;`,
    ),
  );
  return [turnMessages, ...changes].join("\n");
}

/** PostgreSQL: the functions and triggers that number turn messages and record changes. */
export function pgWriteOrderTriggersSql(): string {
  const functions = `
  CREATE OR REPLACE FUNCTION covel_next_session_write(p_session_id text)
    RETURNS bigint LANGUAGE sql AS $fn$
    INSERT INTO session_write_counters AS c (session_id, value)
      VALUES (p_session_id, 1)
      ON CONFLICT (session_id) DO UPDATE SET value = c.value + 1
      RETURNING value
  $fn$;

  CREATE OR REPLACE FUNCTION covel_record_change(
    p_session_id text, p_kind text, p_plugin_id text, p_namespace text, p_key text
  ) RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO record_changes (session_id, kind, plugin_id, namespace, key, seq)
      VALUES (p_session_id, p_kind, p_plugin_id, p_namespace, p_key,
        covel_next_session_write(p_session_id))
      ON CONFLICT (session_id, kind, plugin_id, namespace, key)
      DO UPDATE SET seq = EXCLUDED.seq
  $fn$;

  CREATE OR REPLACE FUNCTION turn_messages_write_seq() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
  BEGIN
    NEW.write_seq := covel_next_session_write(NEW.session_id);
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS turn_messages_write_seq ON turn_messages;
  CREATE TRIGGER turn_messages_write_seq
    BEFORE INSERT ON turn_messages
    FOR EACH ROW
    EXECUTE FUNCTION turn_messages_write_seq();`;
  const changes = RECORD_CHANGE_SOURCES.map(
    (source) => `
  CREATE OR REPLACE FUNCTION ${source.table}_record_change() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM covel_record_change(${identity(source, "OLD")});
    ELSE
      PERFORM covel_record_change(${identity(source, "NEW")});
    END IF;
    RETURN NULL;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS ${source.table}_record_change ON ${source.table};
  CREATE TRIGGER ${source.table}_record_change
    AFTER INSERT OR UPDATE OR DELETE ON ${source.table}
    FOR EACH ROW
    EXECUTE FUNCTION ${source.table}_record_change();`,
  );
  return [functions, ...changes].join("\n");
}
