import {
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  validateBrowserCheckpoint,
  type BrowserCheckpoint,
  type PersistenceProfile,
} from "./browser-sync.js";
import type {
  DataStore,
  RuntimeExportRecord,
  SessionRecord,
  StoreTransaction,
} from "../types.js";

/**
 * A checkpoint is uploaded and downloaded whole at every action of a private
 * session, so what it holds must not grow with every turn played. The state of
 * the game does not; the journals of past executions do, and a session of a
 * hundred turns reached the upload limit on them alone.
 *
 * The trace rows the execution status is read from: the start of the newest
 * turn and how it ended. No other trace row is read outside the debug page.
 */
const RECOVERY_TRACE_TYPES = ["turn.started", "turn.completed", "turn.failed"];

/**
 * How many of the latest executions keep their results and runtime outputs.
 * A retry names a recent turn as its source, and nothing else reads an older
 * row. Messages, the prompt history and all game state are kept in full.
 */
const JOURNAL_EXECUTION_WINDOW = 40;

export interface ExportSessionCheckpointOptions {
  readonly profile?: PersistenceProfile;
  readonly revision: number;
  readonly actionId: string;
  readonly committedAt?: string;
  /**
   * When the source execution of the earliest unfinished background job
   * began. Such a job reads each runtime export as it was at that instant, so
   * the checkpoint keeps the revision that was live then and every later one.
   * Omitted when no job is unfinished: only the newest revision is kept.
   */
  readonly exportsReadableFrom?: string;
}

/**
 * Of each export series, the revision live at `from` and the later ones.
 * `exports` holds each series oldest to newest.
 */
function exportsReadableFrom(
  exports: readonly RuntimeExportRecord[],
  from: string,
): RuntimeExportRecord[] {
  const series = new Map<string, RuntimeExportRecord[]>();
  for (const record of exports) {
    const key = `${record.producerRuntimeId}\u0000${record.recordAs}`;
    const kept = series.get(key);
    if (!kept) series.set(key, [record]);
    else if (record.committedAt <= from) kept.splice(0, kept.length, record);
    else kept.push(record);
  }
  return [...series.values()].flat();
}

export interface ReplaceSessionCheckpointOptions {
  /** Server composition may preserve private owner/incarnation metadata here. */
  readonly session?: SessionRecord;
  /** Global worlds require separate authorization; session replacement preserves them by default. */
  readonly writeWorld?: boolean;
  /** Host initialization joins the atomic checkpoint replacement, never a second commit. */
  readonly afterRestoreInTx?: (tx: StoreTransaction) => Promise<void>;
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
    characterSchema,
    pluginData,
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
    // The log of tool calls and the event trail have no reader: they stay in
    // the workspace that produced them.
    [] as Awaited<ReturnType<DataStore["listToolCalls"]>>,
    store.listRuntimeOutputs(sessionId),
    store.listInteractionRecords(sessionId),
    [] as Awaited<ReturnType<DataStore["listEvents"]>>,
    store.queryTraceEvents(sessionId, { types: RECOVERY_TRACE_TYPES }),
    store.listCharacters(sessionId),
    store.getCharacterSchema(sessionId),
    store.listPluginDataSessionScope(sessionId),
    store.listSessionLorebookEntries(sessionId),
    store.listSessionSummaries(sessionId),
    store.listPlayerInputs(sessionId),
    store.listSuspensions(sessionId),
    store.listSnapshots(sessionId),
    store.listWorldDataImportLedger(sessionId),
    store.listLogicalTurnCompletions(sessionId),
    store.listSetupAttempts(sessionId),
    store.listJobStatus(sessionId),
    // Only the newest revision of each series, unless a background job is
    // still to run: an older one is read by an execution that began before it
    // was replaced, and a queued job is the one such execution that a
    // restored workspace continues.
    options.exportsReadableFrom === undefined
      ? store.listRuntimeExports(sessionId, { latestOnly: true })
      : store
          .listRuntimeExports(sessionId)
          .then((exports) =>
            exportsReadableFrom(exports, options.exportsReadableFrom!),
          ),
    store.listStateSchemas(sessionId),
  ]);

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

  // Rows are in the order they were written; the latest executions are last.
  const recentTurnIds = new Set(
    [...new Set(turnResults.map((result) => result.turnId))].slice(
      -JOURNAL_EXECUTION_WINDOW,
    ),
  );

  const checkpoint = {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    profile: options.profile ?? "browser-private",
    session,
    world,
    messages,
    turnMessages,
    turnResults: turnResults.filter((result) =>
      recentTurnIds.has(result.turnId),
    ),
    toolCalls,
    runtimeOutputs: runtimeOutputs.filter((output) =>
      recentTurnIds.has(output.turnId),
    ),
    interactions,
    events,
    traceEvents,
    characters,
    characterSchema,
    pluginData,
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
  if (options.writeWorld && checkpoint.world)
    await store.upsertWorld(checkpoint.world);
  await store.createSession(session);

  for (const record of checkpoint.turnResults)
    await store.saveTurnResult(record);
  for (const record of checkpoint.toolCalls) await store.saveToolCall(record);
  for (const record of checkpoint.runtimeOutputs)
    await store.saveRuntimeOutput(record);
  for (const record of checkpoint.interactions)
    await store.saveInteractionRecord(record);
  for (const record of checkpoint.events) await store.saveEvent(record);
  for (const record of checkpoint.messages) await store.addMessage(record);
  if (checkpoint.characterSchema)
    await store.upsertCharacterSchema(checkpoint.characterSchema);
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
  await store.withTransaction(async (tx) => {
    await writeCheckpoint(tx, checkpoint, options);
    await options.afterRestoreInTx?.(tx);
  });
}
