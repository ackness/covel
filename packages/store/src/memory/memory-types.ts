import type { DataStore } from "../types.js";
import type {
  CharacterRecord,
  CharacterSchemaRecord,
  EventRecord,
  InteractionRecordRow,
  JobStatusRecord,
  LogicalTurnLedgerRecord,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginDataRecord,
  RuntimeExportRecord,
  RuntimeOutputRecord,
  SessionRecord,
  SessionSummaryRecord,
  SetupAttemptRecord,
  SnapshotRecord,
  SuspensionRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
  ServerSettingRecord,
  RecordChange,
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

/** A stored turn message and its save order in the session. */
export type MemoryTurnMessage = TurnMessageRecord & {
  readonly writeSeq: number;
};

/** The latest change of one record; mirrors a `record_changes` row. */
export interface MemoryRecordChange {
  readonly sessionId: string;
  readonly change: RecordChange;
}

export interface MemoryState {
  readonly sessions: Map<string, SessionRecord>;
  readonly turnResults: TurnResultRecord[];
  readonly toolCalls: ToolCallRecordRow[];
  readonly events: EventRecord[];
  readonly messages: MessageRecord[];
  /** Global message ID -> messages offset; deletion and rollback preserve alignment. */
  readonly messagePositions: Map<string, number>;
  readonly characterSchemas: Map<string, CharacterSchemaRecord>;
  readonly characters: Map<string, CharacterRecord>;
  readonly pluginData: Map<string, PluginDataRecord>;
  readonly suspensions: Map<string, SuspensionRecord>;
  readonly snapshots: Map<string, SnapshotRecord>;
  readonly vectorIndexProgress: Map<
    string,
    { sessionId: string; value: string }
  >;
  readonly vectorRows: Map<string, MemoryVectorRow>;
  readonly vectorModelRegistry: Map<string, VectorTarget>;
  nextModelId: number;
  readonly sessionVectorTargets: Map<string, VectorTarget | null>;
  readonly worlds: Map<string, WorldRecord>;
  readonly serverSettings: Map<string, ServerSettingRecord>;
  readonly traceEvents: TraceEventRecord[];
  readonly runtimeOutputs: RuntimeOutputRecord[];
  readonly interactionRecords: InteractionRecordRow[];
  readonly turnMessages: MemoryTurnMessage[];
  readonly playerInputs: PlayerInputRecord[];
  readonly worldDataImportLedger: Map<string, WorldDataImportLedgerRecord>;
  readonly lorebookEntries: Map<string, LorebookEntryRecord>;
  readonly sessionSummaries: SessionSummaryRecord[];
  // Scheduling-redesign lifecycle collections. Each is a Map keyed by the
  // record's composite unique key (see memory/lifecycle-methods.ts) so inserts
  // stay idempotent, mirroring the SQL unique indexes.
  readonly logicalTurnLedger: Map<string, LogicalTurnLedgerRecord>;
  readonly setupAttempts: Map<string, SetupAttemptRecord>;
  readonly jobStatus: Map<string, JobStatusRecord>;
  // Runtime exports (`output.recordAs` publications). Keyed by the record's
  // composite unique key (see memory/export-methods.ts) so appends stay
  // idempotent, mirroring the SQL unique index.
  readonly runtimeExports: Map<string, RuntimeExportRecord>;
  // Write order (see common/write-order-ddl.ts). `recordChanges` is keyed by
  // the record's identity; `sessionWriteCounters` by session ID. Transactions
  // do not snapshot the counters, so a rollback never hands a number out twice.
  readonly recordChanges: Map<string, MemoryRecordChange>;
  readonly sessionWriteCounters: Map<
    string,
    { readonly sessionId: string; readonly value: number }
  >;
}

export type MemoryStore = DataStore & VectorStoreCapability & VectorModelOps;

export type MemoryStoreMethods = Partial<MemoryStore>;
