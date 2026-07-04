import type { DataStore } from "../types.js";
import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
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
import type {
  VectorModelOps,
  VectorStoreCapability,
  VectorTarget,
} from "../vector-store.js";

/** In-memory vector row. Mutable - this is only for dev/test. */
export interface MemoryVectorRow {
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  dim: number;
  embedding: Float32Array;
  payload: string | null;
}

export interface MemoryState {
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
  readonly suspensions: Map<string, SuspensionRecord>;
  readonly snapshots: Map<string, SnapshotRecord>;
  readonly vectorRows: Map<string, MemoryVectorRow>;
  readonly vectorModelRegistry: Map<string, VectorTarget>;
  nextModelId: number;
  readonly sessionVectorTargets: Map<string, VectorTarget | null>;
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
}

export type MemoryStore = DataStore & VectorStoreCapability & VectorModelOps;

export type MemoryStoreMethods = Partial<MemoryStore>;
