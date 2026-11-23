import { z } from "zod";

export interface AppEventPayloadMap {
  readonly AppStarted: {
    readonly hostId?: string;
    readonly startedAt: string;
  };
  readonly BeforeShutdown: {
    readonly hostId?: string;
    readonly reason: string;
  };
  readonly SessionCreated: {
    readonly sessionId: string;
    readonly worldId: string;
    readonly locale: string;
  };
  readonly SessionTurnCommitted: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly logicalTurn: number;
    readonly committedAt: string;
  };
  readonly SessionDeleted: {
    readonly sessionId: string;
  };
  readonly WorldInstalled: {
    readonly worldId: string;
    readonly source?: string;
  };
  readonly WorldRemoved: {
    readonly worldId: string;
  };
}

export const MIN_SCHEDULER_INTERVAL_MS = 10_000;
export const MAX_SCHEDULER_INTERVAL_MS = 86_400_000;
export const DEFAULT_SCHEDULER_TIMEOUT_MS = 30_000;

export const scheduledTaskIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    message:
      "Scheduled task ID must start with an alphanumeric character and use only letters, digits, `.`, `_`, or `-` (max 64 chars)",
  });

export const scheduledTaskSpecSchema = z.strictObject({
  id: scheduledTaskIdSchema.describe(
    "Unique task identifier registered with `registerScheduledTask`.",
  ),
  intervalMs: z
    .number()
    .int()
    .min(MIN_SCHEDULER_INTERVAL_MS)
    .max(MAX_SCHEDULER_INTERVAL_MS)
    .describe(
      `Minimum interval between runs in ms (${MIN_SCHEDULER_INTERVAL_MS}..${MAX_SCHEDULER_INTERVAL_MS}).`,
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .describe("Per-run AbortSignal deadline in milliseconds (default 30000).")
    .optional(),
  runOnStart: z
    .boolean()
    .describe(
      "When true, schedule an initial run immediately after activation.",
    )
    .optional(),
  description: z
    .union([z.string().min(1), z.record(z.string(), z.string())])
    .describe("Human-readable description of the periodic background task.")
    .optional(),
});

export type ScheduledTaskSpec = z.infer<typeof scheduledTaskSpecSchema>;
