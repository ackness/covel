import { z } from "zod";

import { BlockResponseSchema } from "./block.js";
import { SupportedLocaleSchema } from "./locale.js";

const NonEmptyString = z.string().trim().min(1);
const ActionBaseSchema = z.object({
  requestId: NonEmptyString,
  sessionId: NonEmptyString,
  locale: SupportedLocaleSchema.optional()
});

const SendMessageActionSchema = ActionBaseSchema.extend({
  type: z.literal("send_message"),
  payload: z.object({
    content: NonEmptyString
  })
});

const ExecuteCommandActionSchema = ActionBaseSchema.extend({
  type: z.literal("execute_command"),
  payload: z.object({
    command: NonEmptyString,
    args: z.record(z.string(), z.unknown()).optional()
  })
});

const SubmitBlockResponseActionSchema = ActionBaseSchema.extend({
  type: z.literal("submit_block_response"),
  payload: BlockResponseSchema
});

export const ActionRequestSchema = z.discriminatedUnion("type", [
  SendMessageActionSchema,
  ExecuteCommandActionSchema,
  SubmitBlockResponseActionSchema
]);

export type ActionRequest = z.infer<typeof ActionRequestSchema>;
