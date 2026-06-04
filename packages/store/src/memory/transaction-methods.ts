import {
  replaceArrayContents,
  replaceMapContents,
} from "./collection-helpers.js";
import type {
  MemoryState,
  MemoryStoreMethods,
  MemoryVectorRow,
} from "./memory-types.js";
import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginConfigRecord,
  PluginDataRecord,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  SessionRecord,
  SessionSummaryRecord,
  SnapshotRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
  SuspensionRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";

interface MemorySnapshot {
  readonly sessions: Map<string, SessionRecord>;
  readonly turnResults: TurnResultRecord[];
  readonly runtimeResults: RuntimeResultRecord[];
  readonly toolCalls: ToolCallRecordRow[];
  readonly stateSchemas: StateSchemaRecord[];
  readonly stateEntries: Map<string, StateEntryRecord>;
  readonly stateChanges: StateChangeRecord[];
  readonly events: EventRecord[];
  readonly approvals: ApprovalRecord[];
  readonly messages: MessageRecord[];
  readonly characters: Map<string, CharacterRecord>;
  readonly pluginData: Map<string, PluginDataRecord>;
  readonly pluginConfigs: Map<string, PluginConfigRecord>;
  readonly vectorRows: Map<string, MemoryVectorRow>;
  readonly worlds: Map<string, WorldRecord>;
  readonly traceEvents: TraceEventRecord[];
  readonly runtimeOutputs: RuntimeOutputRecord[];
  readonly interactionRecords: InteractionRecordRow[];
  readonly turnMessages: TurnMessageRecord[];
  readonly playerInputs: PlayerInputRecord[];
  readonly workingMemoryEntries: Map<string, WorkingMemoryRecord>;
  readonly worldDataImportLedger: Map<string, WorldDataImportLedgerRecord>;
  readonly lorebookEntries: Map<string, LorebookEntryRecord>;
  readonly sessionSummaries: SessionSummaryRecord[];
  readonly suspensions: Map<string, SuspensionRecord>;
  readonly snapshots: Map<string, SnapshotRecord>;
}

/**
 * Capture a transaction snapshot.
 *
 * Performance (audit 2026-06-04 finding H3): instead of `structuredClone`-ing
 * every collection (O(total-bytes) per `beginTx`, run on every commit path), we
 * take a *shallow* copy of each collection — a fresh `Map`/array containing the
 * same record references. This is O(row-count) reference copy, not byte deep
 * clone.
 *
 * Correctness invariant this relies on: MemoryStore methods never mutate a
 * stored record object in place. Every write path either pushes a new object,
 * `.set(key, newObject)`, replaces an array slot with a spread copy
 * (`arr[i] = { ...arr[i], ... }`), or `.delete()`s. Patches go through
 * `mergeSessionPatch` which returns a new object. A `Map`/array shallow copy
 * therefore preserves the exact membership at `beginTx`, and `restoreSnapshot`
 * rewinds structure (insertions, deletions, slot replacements) faithfully — the
 * shared record references it restores were never mutated, so isolation and
 * rollback semantics are unchanged.
 *
 * If a future method mutates a stored record in place, that invariant breaks
 * for both this shallow snapshot *and* any reference-sharing reader — the fix
 * is to keep replacing whole records, not to reintroduce a blanket deep clone.
 */
function captureSnapshot(state: MemoryState): MemorySnapshot {
  return {
    sessions: new Map(state.sessions),
    turnResults: [...state.turnResults],
    runtimeResults: [...state.runtimeResults],
    toolCalls: [...state.toolCalls],
    stateSchemas: [...state.stateSchemas],
    stateEntries: new Map(state.stateEntries),
    stateChanges: [...state.stateChanges],
    events: [...state.events],
    approvals: [...state.approvals],
    messages: [...state.messages],
    characters: new Map(state.characters),
    pluginData: new Map(state.pluginData),
    pluginConfigs: new Map(state.pluginConfigs),
    vectorRows: new Map(state.vectorRows),
    worlds: new Map(state.worlds),
    traceEvents: [...state.traceEvents],
    runtimeOutputs: [...state.runtimeOutputs],
    interactionRecords: [...state.interactionRecords],
    turnMessages: [...state.turnMessages],
    playerInputs: [...state.playerInputs],
    workingMemoryEntries: new Map(state.workingMemoryEntries),
    worldDataImportLedger: new Map(state.worldDataImportLedger),
    lorebookEntries: new Map(state.lorebookEntries),
    sessionSummaries: [...state.sessionSummaries],
    suspensions: new Map(state.suspensions),
    snapshots: new Map(state.snapshots),
  };
}

function restoreSnapshot(state: MemoryState, snapshot: MemorySnapshot): void {
  replaceMapContents(state.sessions, snapshot.sessions);
  replaceArrayContents(state.turnResults, snapshot.turnResults);
  replaceArrayContents(state.runtimeResults, snapshot.runtimeResults);
  replaceArrayContents(state.toolCalls, snapshot.toolCalls);
  replaceArrayContents(state.stateSchemas, snapshot.stateSchemas);
  replaceMapContents(state.stateEntries, snapshot.stateEntries);
  replaceArrayContents(state.stateChanges, snapshot.stateChanges);
  replaceArrayContents(state.events, snapshot.events);
  replaceArrayContents(state.approvals, snapshot.approvals);
  replaceArrayContents(state.messages, snapshot.messages);
  replaceMapContents(state.characters, snapshot.characters);
  replaceMapContents(state.pluginData, snapshot.pluginData);
  replaceMapContents(state.pluginConfigs, snapshot.pluginConfigs);
  replaceMapContents(state.vectorRows, snapshot.vectorRows);
  replaceMapContents(state.worlds, snapshot.worlds);
  replaceArrayContents(state.traceEvents, snapshot.traceEvents);
  replaceArrayContents(state.runtimeOutputs, snapshot.runtimeOutputs);
  replaceArrayContents(state.interactionRecords, snapshot.interactionRecords);
  replaceArrayContents(state.turnMessages, snapshot.turnMessages);
  replaceArrayContents(state.playerInputs, snapshot.playerInputs);
  replaceMapContents(state.workingMemoryEntries, snapshot.workingMemoryEntries);
  replaceMapContents(
    state.worldDataImportLedger,
    snapshot.worldDataImportLedger,
  );
  replaceMapContents(state.lorebookEntries, snapshot.lorebookEntries);
  replaceArrayContents(state.sessionSummaries, snapshot.sessionSummaries);
  replaceMapContents(state.suspensions, snapshot.suspensions);
  replaceMapContents(state.snapshots, snapshot.snapshots);
}

export function createTransactionMethods(
  state: MemoryState,
): MemoryStoreMethods {
  let snapshot: MemorySnapshot | null = null;

  return {
    async beginTx() {
      if (snapshot !== null) {
        throw new Error(
          "MemoryStore: nested transactions are not supported (beginTx called while another tx is active)",
        );
      }
      snapshot = captureSnapshot(state);
    },

    async commitTx() {
      if (snapshot === null) {
        throw new Error(
          "MemoryStore: commitTx called without an active transaction",
        );
      }
      snapshot = null;
    },

    async rollbackTx() {
      if (snapshot === null) {
        throw new Error(
          "MemoryStore: rollbackTx called without an active transaction",
        );
      }
      restoreSnapshot(state, snapshot);
      snapshot = null;
    },
  };
}
