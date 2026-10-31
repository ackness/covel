import { z } from "zod";
import type { TurnAction } from "./actions.js";

export const MAX_PLAYER_MESSAGE_CHARS = 100_000;
export const MAX_ACTIONS_PER_SUBMISSION = 8;

const interactionRefSchema = z.strictObject({
  turnId: z.string().min(1).max(256),
  interactionId: z.string().min(1).max(256),
  type: z.enum(["form", "choice", "confirmation"]),
});

/**
 * One action as a client submits it. The server sets `source` and fills a
 * missing `seatId` (the primary seat) and `actorId` (the seat's current
 * character, for kinds taken as a character).
 */
export const turnActionRequestSchema = z.strictObject({
  seatId: z.string().trim().min(1).max(128).optional(),
  kind: z.string().min(1).max(200),
  actorId: z.string().min(1).max(256).optional(),
  text: z.string().max(MAX_PLAYER_MESSAGE_CHARS).optional(),
  fields: z.record(z.string(), z.json()).optional(),
  interaction: interactionRefSchema.optional(),
});

/** One resolved action: `seatId` and `source` always set. */
export const turnActionSchema: z.ZodType<TurnAction> =
  turnActionRequestSchema.extend({
    seatId: z.string().min(1),
    source: z.enum(["player", "system"]),
  });
