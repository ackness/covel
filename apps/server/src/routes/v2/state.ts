/**
 * V2 State routes — query session state tables and change history.
 *
 * Dependencies are injected via Hono context variables:
 *   - store: DataStore
 *   - stateManager: StateManager
 */

import { Hono } from 'hono';
import type { StateManager } from '@covel/state';
import type { DataStore } from '@covel/store';

// ── Env type for DI ─────────────────────────────────────────────────

type Env = {
  Variables: {
    store: DataStore;
    stateManager: StateManager;
  };
};

export const stateRoutes = new Hono<Env>();

// GET /v2/session/:id/state — Get all state tables
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

  for (const schema of schemas) {
    const data = await stateManager.getTableSnapshot(id, schema.name);
    tables[schema.name] = { schema, data: { ...data } };
  }

  return c.json({ tables });
});

// GET /v2/session/:id/state/:table — Get table snapshot
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

// GET /v2/session/:id/state/:table/:field/history — Get field change history
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
