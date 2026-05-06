/**
 * State routes — query session state tables, change history, and snapshots.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET  /api/sessions/:id/state                        — all state tables
 *   GET  /api/sessions/:id/state-patches                — state change patches
 *   GET  /api/sessions/:id/state-snapshot                — full state snapshot
 *   PUT  /api/sessions/:id/state-snapshot                — save state snapshot
 */

import { Hono } from "hono";
import type { StateManager } from "@covel/state";
import type { DataStore } from "@covel/store";

type Env = {
	Variables: {
		store: DataStore;
		stateManager: StateManager;
	};
};

export const stateRoutes = new Hono<Env>();

// GET /sessions/:id/state — aggregated "database view" for the right-panel
// Database tab. Returns a `tables` map where each virtual table holds:
//
//   - `session`: the SessionRecord (turnCount, status, activePlugins,
//     preGameCompleted, runtimeModelOverrides, locale, worldId, etc.).
//   - `characters`: every row in the characters table for this session,
//     keyed by character id.
//   - `plugin_data/<pluginId>:<namespace>`: one virtual table per plugin
//     namespace — keyed by the record's `key`, value is the full JSON.
//   - Any `stateManager`-registered state tables (legacy path; currently
//     no production plugin uses this but kept for future compatibility).
//
// The front-end DatabasePanel renders the map as a list of collapsible
// tables; the `schema.fields` array is derived from the data keys so the
// accordion header shows the right field/value counts even for tables
// with no registered schema.
stateRoutes.get("/:id/state", async (c) => {
	const store = c.get("store");
	const stateManager = c.get("stateManager");
	const id = c.req.param("id");

	const session = await store.getSession(id);
	if (!session) {
		return c.json({ error: `Session not found: ${id}` }, 404);
	}

	const tables: Record<
		string,
		{ schema: unknown; data: Record<string, unknown> }
	> = {};

	// ── Legacy stateManager tables (typically empty today) ────────────
	const schemas = await stateManager.getTableSchemas(id);
	await Promise.all(
		schemas.map(async (schema) => {
			const data = await stateManager.getTableSnapshot(id, schema.name);
			tables[schema.name] = { schema, data: { ...data } };
		}),
	);

	// ── session record ────────────────────────────────────────────────
	const sessionData = { ...session } as Record<string, unknown>;
	tables.session = {
		schema: {
			name: "session",
			description: "Session metadata (turnCount, status, active plugins, etc.)",
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
	} catch {
		// Non-critical: characters table optional on slim stores.
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
	} catch {
		// Non-critical: session may have no plugin_data rows yet.
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
	const stateManager = c.get("stateManager");
	const id = c.req.param("id");

	const session = await store.getSession(id);
	if (!session) {
		return c.json({ error: `Session not found: ${id}` }, 404);
	}

	// Collect all change logs across all tables into a flat patch list (parallel per field)
	const schemas = await stateManager.getTableSchemas(id);
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
				stateManager.getChangeLog(id, schema.name, field.name).then((changes) =>
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
	return c.json(patches);
});

// GET /sessions/:id/state-snapshot — full state snapshot for persistence
stateRoutes.get("/:id/state-snapshot", async (c) => {
	const store = c.get("store");
	const stateManager = c.get("stateManager");
	const id = c.req.param("id");

	const session = await store.getSession(id);
	if (!session) {
		return c.json({ error: `Session not found: ${id}` }, 404);
	}

	const schemas = await stateManager.getTableSchemas(id);
	const snapshot: Record<string, Record<string, unknown>> = {};

	await Promise.all(
		schemas.map(async (schema) => {
			snapshot[schema.name] = await stateManager.getTableSnapshot(
				id,
				schema.name,
			);
		}),
	);

	return c.json(snapshot);
});

// PUT /sessions/:id/state-snapshot — restore state from snapshot (not yet implemented)
stateRoutes.put("/:id/state-snapshot", async (c) => {
	const store = c.get("store");
	const id = c.req.param("id");

	const session = await store.getSession(id);
	if (!session) {
		return c.json({ error: `Session not found: ${id}` }, 404);
	}

	// State restoration requires table re-creation in StateManager.
	// Return 501 so callers know the sync was not applied, rather than
	// returning 200 and silently discarding the data.
	return c.json(
		{
			error:
				"State snapshot restoration not implemented. State will be rebuilt from turn execution.",
		},
		501,
	);
});
