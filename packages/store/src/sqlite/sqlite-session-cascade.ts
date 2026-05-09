import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

type SqliteDb = BetterSQLite3Database<typeof schema>;

export function deleteSqliteSessionCascade(
  sqlite: Database.Database,
  db: SqliteDb,
  sessionId: string,
): void {
  // Keep the full cascade in one SQLite transaction so session deletion is atomic.
  sqlite.transaction(() => {
    db.delete(schema.turnResults)
      .where(eq(schema.turnResults.sessionId, sessionId))
      .run();
    db.delete(schema.runtimeResults)
      .where(eq(schema.runtimeResults.sessionId, sessionId))
      .run();
    db.delete(schema.toolCalls)
      .where(eq(schema.toolCalls.sessionId, sessionId))
      .run();
    db.delete(schema.stateSchemas)
      .where(eq(schema.stateSchemas.sessionId, sessionId))
      .run();
    db.delete(schema.stateEntries)
      .where(eq(schema.stateEntries.sessionId, sessionId))
      .run();
    db.delete(schema.stateChanges)
      .where(eq(schema.stateChanges.sessionId, sessionId))
      .run();
    db.delete(schema.events)
      .where(eq(schema.events.sessionId, sessionId))
      .run();
    db.delete(schema.approvals)
      .where(eq(schema.approvals.sessionId, sessionId))
      .run();
    db.delete(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .run();
    db.delete(schema.characters)
      .where(eq(schema.characters.sessionId, sessionId))
      .run();
    db.delete(schema.pluginData)
      .where(eq(schema.pluginData.sessionId, sessionId))
      .run();
    db.delete(schema.worldDataImportLedger)
      .where(eq(schema.worldDataImportLedger.sessionId, sessionId))
      .run();
    db.delete(schema.pluginConfigs)
      .where(eq(schema.pluginConfigs.sessionId, sessionId))
      .run();
    db.delete(schema.traceEvents)
      .where(eq(schema.traceEvents.sessionId, sessionId))
      .run();
    db.delete(schema.runtimeOutputs)
      .where(eq(schema.runtimeOutputs.sessionId, sessionId))
      .run();
    db.delete(schema.interactionRecords)
      .where(eq(schema.interactionRecords.sessionId, sessionId))
      .run();
    db.delete(schema.turnMessages)
      .where(eq(schema.turnMessages.sessionId, sessionId))
      .run();
    db.delete(schema.playerInputs)
      .where(eq(schema.playerInputs.sessionId, sessionId))
      .run();
    db.delete(schema.workingMemory)
      .where(eq(schema.workingMemory.sessionId, sessionId))
      .run();
    db.delete(schema.lorebookEntries)
      .where(eq(schema.lorebookEntries.sessionId, sessionId))
      .run();
    db.delete(schema.sessionSummaries)
      .where(eq(schema.sessionSummaries.sessionId, sessionId))
      .run();
    sqlite
      .prepare("DELETE FROM suspensions WHERE session_id = ?")
      .run(sessionId);
    sqlite
      .prepare("DELETE FROM state_snapshots WHERE session_id = ?")
      .run(sessionId);
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
  })();
}
