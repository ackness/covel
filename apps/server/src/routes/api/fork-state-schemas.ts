import { randomUUID } from "node:crypto";
import type {
  DataStore,
  SnapshotRecord,
  StateSchemaRecord,
} from "@covel/store";

export class ForkStateSchemaMissingError extends Error {}

/** Restore table definitions from the same point in time as their entries. */
export async function copyForkStateSchemas(
  store: Pick<DataStore, "saveStateSchema">,
  snapshot: SnapshotRecord,
  childSessionId: string,
  now: string,
): Promise<StateSchemaRecord[]> {
  const schemas = snapshot.payload.stateSchemas;
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
