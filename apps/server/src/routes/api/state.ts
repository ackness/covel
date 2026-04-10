/**
 * State routes — query session state tables, change history, and snapshots.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET  /api/sessions/:id/state                        — all state tables
 *   GET  /api/sessions/:id/state/:table                 — table snapshot
 *   GET  /api/sessions/:id/state/:table/:field/history  — field change history
 *   GET  /api/sessions/:id/state-patches                — state change patches
 *   GET  /api/sessions/:id/state-snapshot                — full state snapshot
 *   PUT  /api/sessions/:id/state-snapshot                — save state snapshot
 */

import { Hono } from 'hono';
import type { StateManager } from '@covel/state';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
    stateManager: StateManager;
  };
};

export const stateRoutes = new Hono<Env>();

// GET /sessions/:id/state — Get all state tables
stateRoutes.get('/:id/state', async (c) => {
  const store = c.get('store');
  const stateManager = c.get('stateManager');
  const id = c.req.param('id');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const schemas = await stateManager.getTableSchemas(id);
  const tables: Record<string, { schema: unknown; data: Record<string, unknown> }> = {};

  await Promise.all(schemas.map(async (schema) => {
    const data = await stateManager.getTableSnapshot(id, schema.name);
    tables[schema.name] = { schema, data: { ...data } };
  }));

  return c.json({ tables });
});

// GET /sessions/:id/state/:table — Get table snapshot
stateRoutes.get('/:id/state/:table', async (c) => {
  const store = c.get('store');
  const stateManager = c.get('stateManager');
  const id = c.req.param('id');
  const table = c.req.param('table');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const schemas = await stateManager.getTableSchemas(id);
  const tableSchema = schemas.find((s) => s.name === table);

  if (!tableSchema) {
    return c.json({ error: `Table not found: ${table}` }, 404);
  }

  const data = await stateManager.getTableSnapshot(id, table);

  return c.json({ table, data: { ...data } });
});

// GET /sessions/:id/state/:table/:field/history — Get field change history
stateRoutes.get('/:id/state/:table/:field/history', async (c) => {
  const store = c.get('store');
  const stateManager = c.get('stateManager');
  const id = c.req.param('id');
  const table = c.req.param('table');
  const field = c.req.param('field');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const schemas = await stateManager.getTableSchemas(id);
  const tableSchema = schemas.find((s) => s.name === table);

  if (!tableSchema) {
    return c.json({ error: `Table not found: ${table}` }, 404);
  }

  const fieldDef = tableSchema.fields.find((f) => f.name === field);

  if (!fieldDef) {
    return c.json({ error: `Field not found: ${field}` }, 404);
  }

  const history = await stateManager.getChangeLog(id, table, field);

  return c.json({ table, field, history: [...history] });
});

// ── State patches & snapshots ───────────────────────────────────

// GET /sessions/:id/state-patches — aggregated state change patches
stateRoutes.get('/:id/state-patches', async (c) => {
  const store = c.get('store');
  const stateManager = c.get('stateManager');
  const id = c.req.param('id');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  // Collect all change logs across all tables into a flat patch list (parallel per field)
  const schemas = await stateManager.getTableSchemas(id);
  type Patch = { id: string; summary: string; packageName: string; data?: unknown; createdAt: string };
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
              packageName: change.changedBy ?? 'unknown',
              data: { table: schema.name, field: field.name, value: change.value, reason: change.reason },
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
stateRoutes.get('/:id/state-snapshot', async (c) => {
  const store = c.get('store');
  const stateManager = c.get('stateManager');
  const id = c.req.param('id');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const schemas = await stateManager.getTableSchemas(id);
  const snapshot: Record<string, Record<string, unknown>> = {};

  await Promise.all(schemas.map(async (schema) => {
    snapshot[schema.name] = await stateManager.getTableSnapshot(id, schema.name);
  }));

  return c.json(snapshot);
});

// PUT /sessions/:id/state-snapshot — restore state from snapshot (not yet implemented)
stateRoutes.put('/:id/state-snapshot', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');

  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  // State restoration requires table re-creation in StateManager.
  // Return 501 so callers know the sync was not applied, rather than
  // returning 200 and silently discarding the data.
  return c.json(
    { error: 'State snapshot restoration not implemented. State will be rebuilt from turn execution.' },
    501,
  );
});
