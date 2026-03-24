import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const SseEnvelopeSchema = z.object({
  type: NonEmptyString,
  requestId: NonEmptyString,
  traceId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  flowId: NonEmptyString,
  seq: z.number().int(),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown())
});

export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;
