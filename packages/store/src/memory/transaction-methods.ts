import {
  replaceArrayContents,
  replaceMapContents,
} from "./collection-helpers.js";
import type {
  MemoryState,
  MemoryStoreMethods,
  MemoryVectorRow,
} from "./memory-types.js";
import { cloneVectorRows } from "./vector-methods.js";
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

function captureSnapshot(state: MemoryState): MemorySnapshot {
  return {
    sessions: structuredClone(state.sessions),
    turnResults: structuredClone(state.turnResults),
    runtimeResults: structuredClone(state.runtimeResults),
    toolCalls: structuredClone(state.toolCalls),
    stateSchemas: structuredClone(state.stateSchemas),
    stateEntries: structuredClone(state.stateEntries),
    stateChanges: structuredClone(state.stateChanges),
    events: structuredClone(state.events),
    approvals: structuredClone(state.approvals),
    messages: structuredClone(state.messages),
    characters: structuredClone(state.characters),
    pluginData: structuredClone(state.pluginData),
    pluginConfigs: structuredClone(state.pluginConfigs),
    vectorRows: cloneVectorRows(state.vectorRows),
    worlds: structuredClone(state.worlds),
    traceEvents: structuredClone(state.traceEvents),
    runtimeOutputs: structuredClone(state.runtimeOutputs),
    interactionRecords: structuredClone(state.interactionRecords),
    turnMessages: structuredClone(state.turnMessages),
    playerInputs: structuredClone(state.playerInputs),
    workingMemoryEntries: structuredClone(state.workingMemoryEntries),
    worldDataImportLedger: structuredClone(state.worldDataImportLedger),
    lorebookEntries: structuredClone(state.lorebookEntries),
    sessionSummaries: structuredClone(state.sessionSummaries),
    suspensions: structuredClone(state.suspensions),
    snapshots: structuredClone(state.snapshots),
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
