import { kernelExtensionPoints } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./definition.js";

/** Preserve store provenance and metadata that later prompt stages consume. */
export interface ExtensionHistoryMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sourceType: string;
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string;
  readonly content: string;
  readonly name?: string;
  readonly order: number;
  readonly createdAt: string;
  readonly compactedAtTurnId?: string;
  readonly metadata?: unknown;
  readonly ui?: unknown;
  readonly pendingInput?: unknown;
}

export const historyMessageSchema: z.ZodType<ExtensionHistoryMessage> =
  z.looseObject({
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    sourceType: z.string(),
    sourcePluginId: z.string().optional(),
    sourceRuntimeId: z.string().optional(),
    role: z.string(),
    content: z.string(),
    name: z.string().optional(),
    order: z.number(),
    createdAt: z.string(),
    compactedAtTurnId: z.string().optional(),
    metadata: z.unknown().optional(),
    ui: z.unknown().optional(),
    pendingInput: z.unknown().optional(),
  });

export const promptHistoryTransformV1 = defineExtensionPoint({
  ...kernelExtensionPoints.promptHistoryTransform,
  input: z.object({
    messages: z.array(historyMessageSchema).readonly(),
    turnId: z.string(),
  }),
  output: z.object({ messages: z.array(historyMessageSchema).readonly() }),
  timeoutMs: 500,
  onError: "skip",
});
