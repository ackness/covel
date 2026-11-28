/** Persisted implicit turn-tree records used for in-session branching. */
import type {
  TurnNodeCheckpointKind,
  TurnNodeInputSummary,
} from "@covel/shared/branch";

export type { TurnNodeCheckpointKind, TurnNodeInputSummary };

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

export type TurnNodeMetadata = Pick<
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
