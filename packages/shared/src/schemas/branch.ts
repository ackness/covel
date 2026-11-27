import { z } from "zod";
import { turnActionSchema } from "./action.js";

const actionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const turnNodeInputSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("editable-text"),
    content: z.string(),
    actions: z.array(turnActionSchema),
    hasUserBubble: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("structured-actions"),
    content: z.string(),
    actions: z.array(turnActionSchema),
    replayable: z.boolean(),
    hasUserBubble: z.boolean(),
  }).strict(),
]);

export const turnNodeSummarySchema = z.object({
  id: actionId,
  parentNodeId: actionId.nullable(),
  activeChildId: actionId.nullable(),
  turnId: actionId,
  logicalTurn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  label: z.string().max(256).optional(),
  inputSummary: turnNodeInputSummarySchema.nullable().optional(),
  checkpointKind: z.enum(["base", "delta"]),
  createdAt: z.string(),
  childCount: z.number().int().nonnegative().optional(),
}).strict();

export const sessionBranchSummarySchema = z.object({
  activeNodeId: actionId.nullable(),
  branchEpoch: z.number().int().nonnegative(),
  nodes: z.array(turnNodeSummarySchema),
}).strict();

export const branchSwitchRequestSchema = z.object({
  nodeId: actionId,
  discardUnsettled: z.boolean().optional(),
}).strict();

export const branchLabelRequestSchema = z.object({
  label: z.string().max(256).nullable(),
}).strict();

export const branchDeleteRequestSchema = z.object({
  discardUnsettled: z.boolean().optional(),
}).strict();
