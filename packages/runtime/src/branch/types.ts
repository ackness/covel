import type {
  CharacterRecord,
  CharacterSchemaRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginDataRecord,
  RuntimeExportRecord,
  SessionSummaryRecord,
  SnapshotSessionState,
  SuspensionRecord,
  TurnMessageRecord,
} from "@covel/store";

/** A keyed collection change captured between two branch checkpoints. */
export interface BranchCollectionDelta<T> {
  readonly upserts: readonly T[];
  readonly deletes: readonly string[];
}

/**
 * Incremental state written by a turn node. Small, slowly changing domains are
 * stored as complete values while append-only domains are represented by rows.
 */
export interface TurnStateDelta {
  readonly session?: SnapshotSessionState;
  readonly characterSchema?: CharacterSchemaRecord | null;
  readonly characters?: BranchCollectionDelta<CharacterRecord>;
  readonly pluginData?: BranchCollectionDelta<PluginDataRecord>;
  readonly lorebookEntries?: BranchCollectionDelta<LorebookEntryRecord>;
  readonly runtimeExports?: readonly RuntimeExportRecord[];
  readonly suspensions?: readonly SuspensionRecord[];
  readonly sessionSummaries?: readonly SessionSummaryRecord[];
  readonly compactedMessageSummaryIds?: Readonly<Record<string, string>>;
  readonly messagesAdded?: readonly MessageRecord[];
  readonly turnMessagesAdded?: readonly TurnMessageRecord[];
  readonly playerInputsAdded?: readonly PlayerInputRecord[];
  readonly interactionRecordsAdded?: readonly InteractionRecordRow[];
}

/** The complete state captured at a keyframe node. */
export interface BranchBasePayload {
  readonly session: SnapshotSessionState;
  readonly characterSchema: CharacterSchemaRecord | null;
  readonly characters: readonly CharacterRecord[];
  readonly pluginData: readonly PluginDataRecord[];
  readonly lorebookEntries: readonly LorebookEntryRecord[];
  readonly runtimeExports: readonly RuntimeExportRecord[];
  readonly suspensions: readonly SuspensionRecord[];
  readonly sessionSummaries: readonly SessionSummaryRecord[];
  readonly compactedMessageSummaryIds: Readonly<Record<string, string>>;
  readonly messages: readonly MessageRecord[];
  readonly turnMessages: readonly TurnMessageRecord[];
  readonly playerInputs: readonly PlayerInputRecord[];
  readonly interactionRecords: readonly InteractionRecordRow[];
}

export type TurnNodeCheckpointKind = "base" | "delta";

/** Minimal persisted node shape needed to materialize a branch. */
export interface BranchTurnNode {
  readonly id: string;
  readonly parentNodeId: string | null;
  readonly activeChildId: string | null;
  readonly turnId: string;
  readonly turnIds: readonly string[];
  readonly logicalTurn: number;
  readonly seq: number;
  readonly checkpointKind: TurnNodeCheckpointKind;
  readonly baseNodeId: string;
  readonly depthFromBase: number;
  readonly statePayload: BranchBasePayload | TurnStateDelta;
}

/** Fully materialized state at a node. */
export interface MaterializedBranchState extends BranchBasePayload {}
