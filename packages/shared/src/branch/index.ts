/** Shared contracts and Zod schemas for the implicit turn-node branch tree. */
import { z } from "zod";
import {
  turnActionSchema,
  type TurnAction,
} from "@covel/plugin-handlers-utils";

export type TurnNodeCheckpointKind = "base" | "delta";

export type TurnNodeInputSummary =
  | {
      readonly kind: "editable-text";
      readonly content: string;
      readonly actions: readonly TurnAction[];
      readonly hasUserBubble: boolean;
    }
  | {
      readonly kind: "structured-actions";
      readonly content: string;
      readonly actions: readonly TurnAction[];
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

const branchNodeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const turnNodeInputSummarySchema: z.ZodType<TurnNodeInputSummary> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("editable-text"),
        content: z.string(),
        actions: z.array(turnActionSchema),
        hasUserBubble: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("structured-actions"),
        content: z.string(),
        actions: z.array(turnActionSchema),
        replayable: z.boolean(),
        hasUserBubble: z.boolean(),
      })
      .strict(),
  ]);

export const turnNodeSummarySchema: z.ZodType<TurnNodeSummary> = z
  .object({
    id: branchNodeIdSchema,
    parentNodeId: branchNodeIdSchema.nullable(),
    activeChildId: branchNodeIdSchema.nullable(),
    turnId: branchNodeIdSchema,
    logicalTurn: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    label: z.string().max(256).optional(),
    inputSummary: turnNodeInputSummarySchema.nullable().optional(),
    checkpointKind: z.enum(["base", "delta"]),
    createdAt: z.string(),
    childCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const sessionBranchSummarySchema: z.ZodType<SessionBranchSummary> = z
  .object({
    activeNodeId: branchNodeIdSchema.nullable(),
    branchEpoch: z.number().int().nonnegative(),
    nodes: z.array(turnNodeSummarySchema),
  })
  .strict();

export const branchSwitchRequestSchema = z
  .object({
    nodeId: branchNodeIdSchema,
    discardUnsettled: z.boolean().optional(),
  })
  .strict();

export const branchLabelRequestSchema = z
  .object({
    label: z.string().max(256).nullable(),
  })
  .strict();

export const branchDeleteRequestSchema = z
  .object({
    discardUnsettled: z.boolean().optional(),
  })
  .strict();
