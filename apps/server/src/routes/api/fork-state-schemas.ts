import { randomUUID } from "node:crypto";
import type {
  DataStore,
  SnapshotRecord,
  StateSchemaRecord,
} from "@covel/store";

export class ForkStateSchemaMissingError extends Error {}

/** Restore table definitions from the same point in time as their entries. */
export async function copyForkStateSchemas(
  store: Pick<DataStore, "listStateSchemas" | "saveStateSchema">,
  snapshot: SnapshotRecord,
  childSessionId: string,
  now: string,
): Promise<StateSchemaRecord[]> {
  // Legacy v3 did not freeze definitions. Use the parent's available schemas,
  // but reject missing tables instead of silently hiding restored values.
  const schemas =
    snapshot.payload.stateSchemas ??
    (await store.listStateSchemas(snapshot.sessionId));
  const tables = new Set(schemas.map((schema) => schema.tableName));
  if (
    snapshot.payload.stateEntries.some((entry) => !tables.has(entry.tableName))
  ) {
    throw new ForkStateSchemaMissingError();
  }
  const childSchemas = schemas.map((schema) => ({
    ...schema,
    id: randomUUID(),
    sessionId: childSessionId,
    createdAt: now,
  }));
  for (const schema of childSchemas) await store.saveStateSchema(schema);
  return childSchemas;
}
