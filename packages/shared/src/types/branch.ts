/** Shared contracts for the implicit turn-node branch tree. */

export type TurnNodeCheckpointKind = "base" | "delta";

export type TurnNodeInputSummary =
  | {
      readonly kind: "editable-text";
      readonly content: string;
      readonly actions: readonly import("./action.js").TurnAction[];
      readonly hasUserBubble: boolean;
    }
  | {
      readonly kind: "structured-actions";
      readonly content: string;
      readonly actions: readonly import("./action.js").TurnAction[];
      readonly replayable: boolean;
      readonly hasUserBubble: boolean;
    };

/** Lightweight topology projection safe to return from branch endpoints. */
export interface TurnNodeSummary {
  readonly id: string;
  readonly parentNodeId: string | null;
  readonly activeChildId: string | null;
  readonly turnId: string;
  readonly logicalTurn: number;
  readonly seq: number;
  readonly label?: string;
  readonly inputSummary?: TurnNodeInputSummary | null;
  readonly checkpointKind: TurnNodeCheckpointKind;
  readonly createdAt: string;
  readonly childCount?: number;
}

export interface SessionBranchSummary {
  readonly activeNodeId: string | null;
  readonly branchEpoch: number;
  readonly nodes: readonly TurnNodeSummary[];
}

export interface BranchSwitchResponse extends SessionBranchSummary {
  readonly view?: unknown;
}

export interface BranchDeleteResponse {
  readonly deletedNodeIds: readonly string[];
  readonly activeNodeId: string | null;
  readonly branchEpoch: number;
  readonly switched: boolean;
}
