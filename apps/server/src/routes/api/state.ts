/**
 * State routes — query session, character and plugin-data virtual tables.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET  /api/sessions/:id/state                        — session, characters and plugin data
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  isPublicPluginDataRecord,
  publicPluginDataValue,
} from "./plugin-rpc/runtime-job-public.js";
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
//
// The front-end DatabasePanel renders the map as a list of collapsible
// tables; the `schema.fields` array is derived from the data keys so the
// accordion header shows the right field/value counts even for tables
// with no registered schema.
//
// Rate-limited like the other whole-session reads: one call reads every
// character and plugin-data row of the session.
stateRoutes.get("/:id/state", rateLimiter({ max: 120 }), async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const tables: Record<
    string,
    { schema: unknown; data: Record<string, unknown> }
  > = Object.create(null);

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
  {
    const characters = await store.listCharacters(id);
    const sample = characters[0];
    if (sample) {
      const data: Record<string, unknown> = Object.create(null);
      for (const ch of characters) {
        data[ch.id] = ch;
      }
      tables.characters = {
        schema: {
          name: "characters",
          description: `${characters.length} character(s)`,
          fields: Object.keys(sample).map((name) => ({
            name,
            type: typeOf((sample as unknown as Record<string, unknown>)[name]),
          })),
        },
        data,
      };
    }
  }

  // ── plugin_data grouped by (pluginId, namespace) ──────────────────
  {
    const pluginRows = await store.listPluginDataSessionScope(id);
    const byTable = new Map<
      string,
      { keys: Set<string>; data: Record<string, unknown> }
    >();
    for (const row of pluginRows) {
      if (!isPublicPluginDataRecord(row)) continue;
      const tableName = `plugin_data/${row.pluginId}:${row.namespace}`;
      let entry = byTable.get(tableName);
      if (!entry) {
        entry = { keys: new Set(), data: Object.create(null) };
        byTable.set(tableName, entry);
      }
      entry.data[row.key] = publicPluginDataValue(row);
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
  }

  return c.json({ tables });
});

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
