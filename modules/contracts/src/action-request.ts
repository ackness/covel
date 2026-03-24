import { z } from "zod";

import { BlockResponseSchema } from "./block.js";

const NonEmptyString = z.string().trim().min(1);

const SendMessageActionSchema = z.object({
  requestId: NonEmptyString,
  type: z.literal("send_message"),
  sessionId: NonEmptyString,
  payload: z.object({
    content: NonEmptyString
  })
});

const ExecuteCommandActionSchema = z.object({
  requestId: NonEmptyString,
  type: z.literal("execute_command"),
  sessionId: NonEmptyString,
  payload: z.object({
    command: NonEmptyString,
    args: z.record(z.string(), z.unknown()).optional()
  })
});

const SubmitBlockResponseActionSchema = z.object({
  requestId: NonEmptyString,
  type: z.literal("submit_block_response"),
  sessionId: NonEmptyString,
  payload: BlockResponseSchema
});

export const ActionRequestSchema = z.discriminatedUnion("type", [
  SendMessageActionSchema,
  ExecuteCommandActionSchema,
  SubmitBlockResponseActionSchema
]);

export type ActionRequest = z.infer<typeof ActionRequestSchema>;
