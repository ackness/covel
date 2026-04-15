/**
 * Zod schemas for InteractionRecord entries.
 *
 * Mirrors `types/interaction-record.ts`. The type enum is named
 * `interactionRecordTypeSchema` (not `interactionTypeSchema`) to avoid
 * collision with the UI-layer `InteractionType` enum in execution.ts.
 */

import { z } from 'zod';

export const interactionSourceSchema = z.enum([
  'player',
  'plugin-ui',
  'external-api',
]);

export const interactionChannelSchema = z.enum([
  'web',
  'cli',
  'api',
  'external',
]);

export const interactionRecordTypeSchema = z.enum([
  'message',
  'click',
  'form-submit',
  'rpc-call',
  'skill-invoke',
]);

export const interactionRecordMetaDataSchema = z.object({
  selectionSnapshot: z.unknown().optional(),
  userAgent: z.string().optional(),
});

export const interactionRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  timestamp: z.string().min(1),
  source: interactionSourceSchema,
  channel: interactionChannelSchema,
  type: interactionRecordTypeSchema,
  targetPluginId: z.string().min(1).optional(),
  targetRuntimeId: z.string().min(1).optional(),
  payload: z.unknown(),
  metaData: interactionRecordMetaDataSchema.optional(),
});

export type InteractionRecordSchema = z.infer<typeof interactionRecordSchema>;
