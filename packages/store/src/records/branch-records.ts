/** Persisted implicit turn-tree records used for in-session branching. */

export type TurnNodeCheckpointKind = "base" | "delta";

export interface TurnNodeInputSummary {
  readonly kind: "editable-text" | "structured-actions";
  readonly content: string;
  readonly actions: readonly unknown[];
  readonly hasUserBubble: boolean;
  readonly replayable?: boolean;
}

export interface TurnNodeRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentNodeId?: string | null;
  readonly activeChildId?: string | null;
  readonly turnId: string;
  readonly turnIds: readonly string[];
  readonly logicalTurn: number;
  readonly seq: number;
  readonly label?: string | null;
  readonly inputSummary?: TurnNodeInputSummary | null;
  readonly checkpointKind: TurnNodeCheckpointKind;
  readonly baseNodeId: string;
  readonly depthFromBase: number;
  readonly statePayload: unknown;
  readonly tailDelta?: unknown;
  readonly messagesAdded: readonly unknown[];
  readonly turnMessagesAdded: readonly unknown[];
  readonly playerInputsAdded: readonly unknown[];
  readonly interactionRecordsAdded: readonly unknown[];
  readonly mediaRefIds: readonly string[];
  readonly capturedThroughWriteSeq: number;
  readonly createdAt: string;
}

export type TurnNodeInsert = TurnNodeRecord;

export type TurnNodeSummary = Pick<
  TurnNodeRecord,
  | "id"
  | "sessionId"
  | "parentNodeId"
  | "activeChildId"
  | "turnId"
  | "turnIds"
  | "logicalTurn"
  | "seq"
  | "label"
  | "inputSummary"
  | "checkpointKind"
  | "baseNodeId"
  | "depthFromBase"
  | "mediaRefIds"
  | "capturedThroughWriteSeq"
  | "createdAt"
>;
