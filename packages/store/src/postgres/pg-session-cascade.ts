import { eq } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

type PgTx = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export async function deletePgSessionCascade(
  tx: PgTx,
  sessionId: string,
): Promise<void> {
  // Delete all session-scoped child rows before removing the session itself.
  await tx
    .delete(schema.turnResults)
    .where(eq(schema.turnResults.sessionId, sessionId));
  await tx
    .delete(schema.runtimeResults)
    .where(eq(schema.runtimeResults.sessionId, sessionId));
  await tx
    .delete(schema.toolCalls)
    .where(eq(schema.toolCalls.sessionId, sessionId));
  await tx
    .delete(schema.stateSchemas)
    .where(eq(schema.stateSchemas.sessionId, sessionId));
  await tx
    .delete(schema.stateEntries)
    .where(eq(schema.stateEntries.sessionId, sessionId));
  await tx
    .delete(schema.stateChanges)
    .where(eq(schema.stateChanges.sessionId, sessionId));
  await tx.delete(schema.events).where(eq(schema.events.sessionId, sessionId));
  await tx
    .delete(schema.approvals)
    .where(eq(schema.approvals.sessionId, sessionId));
  await tx
    .delete(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId));
  await tx
    .delete(schema.characters)
    .where(eq(schema.characters.sessionId, sessionId));
  await tx
    .delete(schema.pluginData)
    .where(eq(schema.pluginData.sessionId, sessionId));
  await tx
    .delete(schema.worldDataImportLedger)
    .where(eq(schema.worldDataImportLedger.sessionId, sessionId));
  await tx
    .delete(schema.pluginConfigs)
    .where(eq(schema.pluginConfigs.sessionId, sessionId));
  await tx
    .delete(schema.traceEvents)
    .where(eq(schema.traceEvents.sessionId, sessionId));
  await tx
    .delete(schema.runtimeOutputs)
    .where(eq(schema.runtimeOutputs.sessionId, sessionId));
  await tx
    .delete(schema.interactionRecords)
    .where(eq(schema.interactionRecords.sessionId, sessionId));
  await tx
    .delete(schema.turnMessages)
    .where(eq(schema.turnMessages.sessionId, sessionId));
  await tx
    .delete(schema.playerInputs)
    .where(eq(schema.playerInputs.sessionId, sessionId));
  await tx
    .delete(schema.workingMemory)
    .where(eq(schema.workingMemory.sessionId, sessionId));
  await tx
    .delete(schema.lorebookEntries)
    .where(eq(schema.lorebookEntries.sessionId, sessionId));
  await tx
    .delete(schema.sessionSummaries)
    .where(eq(schema.sessionSummaries.sessionId, sessionId));
  await tx
    .delete(schema.suspensions)
    .where(eq(schema.suspensions.sessionId, sessionId));
  await tx
    .delete(schema.stateSnapshots)
    .where(eq(schema.stateSnapshots.sessionId, sessionId));
  await tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}
