/**
 * Zod schemas for RuntimeOutput records.
 *
 * Used by the store layer to validate JSONB payloads on write and by the
 * API layer to validate query responses. Mirrors the types in
 * `types/runtime-output.ts` one-for-one.
 */

import { z } from 'zod';

export const runtimeOutputResultSchema = z.object({
  text: z.string(),
  structured: z.unknown().optional(),
});

export const runtimeOutputToolCallSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  status: z.enum(['success', 'error']),
  durationMs: z.number().int().nonnegative(),
});

export const runtimeOutputPromptMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
});

export const runtimeOutputMetaDataSchema = z.object({
  turn: z.number().int().nonnegative(),
  playingTurn: z.number().int().nonnegative().optional(),
  phase: z.string(),
  rawPromptDelta: z.array(runtimeOutputPromptMessageSchema).optional(),
  outputResponses: z.array(z.string()).optional(),
  toolCallList: z.array(runtimeOutputToolCallSchema).optional(),
  modelSlot: z.string().optional(),
  tokenUsage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
});

export const runtimeOutputSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  runtimeResultId: z.string().min(1).optional(),
  pluginId: z.string().min(1),
  runtimeId: z.string().min(1),
  timestamp: z.string().min(1),
  results: z.array(runtimeOutputResultSchema),
  metaData: runtimeOutputMetaDataSchema,
});

export type RuntimeOutputSchema = z.infer<typeof runtimeOutputSchema>;
