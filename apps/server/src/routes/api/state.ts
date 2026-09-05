/**
 * State routes — query session state tables and change history.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET  /api/sessions/:id/state                        — all state tables
 *   GET  /api/sessions/:id/state-patches                — state change patches
 */

import { Hono } from "hono";
import type { StateChangeEntry, StateTableSchema } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  publicSessionMetadata,
  resolveSessionParam,
} from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const stateRoutes = new Hono<Env>();

// GET /sessions/:id/state — aggregated "database view" for the right-panel
// Database tab. Returns a `tables` map where each virtual table holds:
//
//   - `session`: the SessionRecord (phase, completedPlayerTurns, status,
//     activePlugins, runtimeModelOverrides, locale, worldId, etc.).
//   - `characters`: every row in the characters table for this session,
//     keyed by character id.
//   - `plugin_data/<pluginId>:<namespace>`: one virtual table per plugin
//     namespace — keyed by the record's `key`, value is the full JSON.
//   - Any state tables registered in the canonical DataStore.
//
// The front-end DatabasePanel renders the map as a list of collapsible
// tables; the `schema.fields` array is derived from the data keys so the
// accordion header shows the right field/value counts even for tables
// with no registered schema.
stateRoutes.get("/:id/state", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const tables: Record<
    string,
    { schema: unknown; data: Record<string, unknown> }
  > = {};

  // ── State tables ──────────────────────────────────────────────────
  const schemas = await getTableSchemas(store, id);
  await Promise.all(
    schemas.map(async (schema) => {
      const data = await getTableSnapshot(store, id, schema.name);
      tables[schema.name] = { schema, data: { ...data } };
    }),
  );

  // ── session record ────────────────────────────────────────────────
  const sessionData = {
    ...session,
    ...(session.metadata
      ? { metadata: publicSessionMetadata(session.metadata) }
      : {}),
  } as Record<string, unknown>;
  tables.session = {
    schema: {
      name: "session",
      description:
        "Session metadata (phase, completed player turns, active plugins, etc.)",
      fields: Object.keys(sessionData).map((name) => ({
        name,
        type: typeOf(sessionData[name]),
      })),
    },
    data: sessionData,
  };

  // ── characters ────────────────────────────────────────────────────
  try {
    const characters = await store.listCharacters(id);
    if (characters.length > 0) {
      const data: Record<string, unknown> = {};
      for (const ch of characters) {
        data[ch.id] = ch;
      }
      tables.characters = {
        schema: {
          name: "characters",
          description: `${characters.length} character(s)`,
          fields: Object.keys(characters[0]).map((name) => ({
            name,
            type: typeOf(
              (characters[0] as unknown as Record<string, unknown>)[name],
            ),
          })),
        },
        data,
      };
    }
  } catch (err) {
    // Non-critical: characters table optional on slim stores.
    console.warn(`[state] characters query failed for session ${id}:`, err);
  }

  // ── plugin_data grouped by (pluginId, namespace) ──────────────────
  try {
    const pluginRows = await store.listPluginDataSessionScope(id);
    const byTable = new Map<
      string,
      { keys: Set<string>; data: Record<string, unknown> }
    >();
    for (const row of pluginRows) {
      const tableName = `plugin_data/${row.pluginId}:${row.namespace}`;
      let entry = byTable.get(tableName);
      if (!entry) {
        entry = { keys: new Set(), data: {} };
        byTable.set(tableName, entry);
      }
      entry.data[row.key] = row.value;
      entry.keys.add(row.key);
    }
    // Stable alphabetical ordering so the UI doesn't shuffle between refreshes.
    const sortedNames = [...byTable.keys()].sort();
    for (const name of sortedNames) {
      const entry = byTable.get(name)!;
      tables[name] = {
        schema: {
          name,
          description: `${entry.keys.size} entr${entry.keys.size === 1 ? "y" : "ies"}`,
          fields: [...entry.keys].slice(0, 50).map((key) => ({
            name: key,
            type: typeOf(entry.data[key]),
          })),
        },
        data: entry.data,
      };
    }
  } catch (err) {
    // Non-critical: session may have no plugin_data rows yet.
    console.warn(`[state] plugin_data query failed for session ${id}:`, err);
  }

  return c.json({ tables });
});

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ── State patches & snapshots ───────────────────────────────────

// GET /sessions/:id/state-patches — aggregated state change patches
stateRoutes.get("/:id/state-patches", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  // Collect all change logs across all tables into a flat patch list (parallel per field)
  const schemas = await getTableSchemas(store, id);
  type Patch = {
    id: string;
    summary: string;
    packageName: string;
    data?: unknown;
    createdAt: string;
  };
  const fieldQueries: Array<Promise<Patch[]>> = [];

  for (const schema of schemas) {
    for (const field of schema.fields) {
      fieldQueries.push(
        getChangeLog(store, id, schema.name, field.name).then((changes) =>
          changes.map((change) => {
            const ts = change.timestamp ?? new Date().toISOString();
            return {
              id: `${schema.name}.${field.name}@${ts}`,
              summary: `${schema.name}.${field.name} → ${JSON.stringify(change.value)}`,
              packageName: change.changedBy ?? "unknown",
              data: {
                table: schema.name,
                field: field.name,
                value: change.value,
                reason: change.reason,
              },
              createdAt: ts,
            };
          }),
        ),
      );
    }
  }

  const patches = (await Promise.all(fieldQueries)).flat();
  return c.json({ items: patches });
});

async function getTableSchemas(
  store: DataStore,
  sessionId: string,
): Promise<readonly StateTableSchema[]> {
  const records = await store.listStateSchemas(sessionId);
  return records.map((record) => record.schema as StateTableSchema);
}

async function getTableSnapshot(
  store: DataStore,
  sessionId: string,
  tableName: string,
): Promise<Readonly<Record<string, unknown>>> {
  const entries = await store.listStateEntries(sessionId, tableName);
  return Object.fromEntries(
    entries.map((entry) => [entry.fieldName, entry.value]),
  );
}

async function getChangeLog(
  store: DataStore,
  sessionId: string,
  tableName: string,
  fieldName: string,
): Promise<readonly StateChangeEntry[]> {
  const changes = await store.listStateChanges(sessionId, tableName, fieldName);
  return changes
    .filter((change) => change.turnId !== "__init__")
    .map((change) => ({
      value: change.value,
      changedBy: change.changedBy,
      turnId: change.turnId,
      reason: change.reason,
      timestamp: change.createdAt,
    }));
}
