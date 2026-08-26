import {
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  validateBrowserCheckpoint,
  type BrowserCheckpoint,
  type PersistenceProfile,
} from "./browser-sync.js";
import type { DataStore, SessionRecord, StoreTransaction } from "../types.js";

export interface ExportSessionCheckpointOptions {
  readonly profile?: PersistenceProfile;
  readonly revision: number;
  readonly actionId: string;
  readonly committedAt?: string;
}

export interface ReplaceSessionCheckpointOptions {
  /** Server composition may preserve private owner/incarnation metadata here. */
  readonly session?: SessionRecord;
}

/** Export every durable session domain needed to resume execution elsewhere. */
export async function exportSessionCheckpoint(
  store: DataStore,
  sessionId: string,
  options: ExportSessionCheckpointOptions,
): Promise<BrowserCheckpoint> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const [
    world,
    messages,
    turnMessages,
    turnResults,
    toolCalls,
    runtimeOutputs,
    interactions,
    events,
    traceEvents,
    characters,
    pluginData,
    workingMemory,
    lorebookEntries,
    sessionSummaries,
    playerInputs,
    suspensions,
    snapshots,
    worldDataLedger,
    logicalTurnLedger,
    setupAttempts,
    jobStatus,
    runtimeExports,
    stateSchemas,
  ] = await Promise.all([
    session.worldId ? store.getWorld(session.worldId) : Promise.resolve(null),
    store.listMessages(sessionId),
    store.listTurnMessages(sessionId),
    store.listTurnResults(sessionId),
    store.listToolCalls(sessionId),
    store.listRuntimeOutputs(sessionId),
    store.listInteractionRecords(sessionId),
    store.listEvents(sessionId),
    store.listTraceEvents(sessionId),
    store.listCharacters(sessionId),
    store.listPluginDataSessionScope(sessionId),
    store.listWorkingMemory(sessionId),
    store.listSessionLorebookEntries(sessionId),
    store.listSessionSummaries(sessionId),
    store.listPlayerInputs(sessionId),
    store.listSuspensions(sessionId),
    store.listSnapshots(sessionId),
    store.listWorldDataImportLedger(sessionId),
    store.listLogicalTurnCompletions(sessionId),
    store.listSetupAttempts(sessionId),
    store.listJobStatus(sessionId),
    store.listRuntimeExports(sessionId),
    store.listStateSchemas(sessionId),
  ]);

  const runtimeResults = (
    await Promise.all(
      [...new Set(turnResults.map((result) => result.turnId))].map((turnId) =>
        store.listRuntimeResults(sessionId, turnId),
      ),
    )
  ).flat();
  const stateEntries = (
    await Promise.all(
      stateSchemas.map((schema) =>
        store.listStateEntries(sessionId, schema.tableName),
      ),
    )
  ).flat();
  const stateChanges = (
    await Promise.all(
      stateEntries.map((entry) =>
        store.listStateChanges(sessionId, entry.tableName, entry.fieldName),
      ),
    )
  ).flat();

  const checkpoint = {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    profile: options.profile ?? "browser-private",
    session,
    world,
    messages,
    turnMessages,
    turnResults,
    runtimeResults,
    toolCalls,
    runtimeOutputs,
    interactions,
    events,
    traceEvents,
    characters,
    pluginData,
    workingMemory,
    lorebookEntries,
    sessionSummaries,
    playerInputs,
    suspensions,
    snapshots,
    worldDataLedger,
    logicalTurnLedger,
    setupAttempts,
    jobStatus,
    runtimeExports,
    state: {
      schemas: stateSchemas,
      entries: stateEntries,
      changes: stateChanges,
    },
    revision: options.revision,
    actionId: options.actionId,
    committedAt: options.committedAt ?? new Date().toISOString(),
  };
  // Store records use optional properties with `undefined`; the wire contract
  // is JSON, where such object properties are omitted. Normalize at the
  // boundary so a valid in-memory record cannot produce an invalid payload.
  return validateBrowserCheckpoint(
    JSON.parse(JSON.stringify(checkpoint)) as unknown,
  );
}

async function writeCheckpoint(
  store: StoreTransaction,
  checkpoint: BrowserCheckpoint,
  options: ReplaceSessionCheckpointOptions,
): Promise<void> {
  const session = options.session ?? checkpoint.session;
  if (session.id !== checkpoint.sessionId) {
    throw new Error("Replacement session id must match the checkpoint");
  }

  await store.deleteSession(checkpoint.sessionId);
  if (checkpoint.world) await store.upsertWorld(checkpoint.world);
  await store.createSession(session);

  for (const record of checkpoint.turnResults)
    await store.saveTurnResult(record);
  for (const record of checkpoint.runtimeResults)
    await store.saveRuntimeResult(record);
  for (const record of checkpoint.toolCalls) await store.saveToolCall(record);
  for (const record of checkpoint.runtimeOutputs)
    await store.saveRuntimeOutput(record);
  for (const record of checkpoint.interactions)
    await store.saveInteractionRecord(record);
  for (const record of checkpoint.events) await store.saveEvent(record);
  for (const record of checkpoint.messages) await store.addMessage(record);
  for (const record of checkpoint.characters)
    await store.upsertCharacter(record);
  if (checkpoint.pluginData.length > 0) {
    await store.setPluginDataBatch(checkpoint.pluginData);
  }
  for (const record of checkpoint.traceEvents)
    await store.addTraceEvent(record);
  for (const record of checkpoint.turnMessages)
    await store.appendTurnMessage(record);
  for (const record of checkpoint.playerInputs)
    await store.savePlayerInput(record);
  for (const record of checkpoint.workingMemory)
    await store.upsertWorkingMemory(record);
  if (checkpoint.worldDataLedger.length > 0) {
    await store.saveWorldDataImportLedgerBatch(checkpoint.worldDataLedger);
  }
  if (checkpoint.lorebookEntries.length > 0) {
    await store.upsertLorebookEntries(checkpoint.lorebookEntries);
  }
  for (const record of checkpoint.sessionSummaries)
    await store.saveSessionSummary(record);
  for (const record of checkpoint.suspensions)
    await store.saveSuspension(record);
  for (const record of checkpoint.snapshots) await store.saveSnapshot(record);
  for (const record of checkpoint.logicalTurnLedger)
    await store.insertLogicalTurnCompletion(record);
  for (const record of checkpoint.setupAttempts)
    await store.insertSetupAttempt(record);
  for (const record of checkpoint.jobStatus)
    await store.appendJobStatus(record);
  for (const record of checkpoint.runtimeExports)
    await store.appendRuntimeExport(record);

  if (checkpoint.state) {
    for (const record of checkpoint.state.schemas)
      await store.saveStateSchema(record);
    for (const record of checkpoint.state.entries)
      await store.upsertStateEntry(record);
    for (const record of checkpoint.state.changes)
      await store.addStateChange(record);
  }
}

/** Atomically replace one transient workspace from a browser checkpoint. */
export async function replaceSessionFromCheckpoint(
  store: DataStore,
  value: BrowserCheckpoint,
  options: ReplaceSessionCheckpointOptions = {},
): Promise<void> {
  const checkpoint = validateBrowserCheckpoint(value);
  await store.withTransaction((tx) => writeCheckpoint(tx, checkpoint, options));
}
