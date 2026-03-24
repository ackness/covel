import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const TraceRecordSchema = z.object({
  traceId: NonEmptyString,
  spanId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  component: NonEmptyString,
  eventType: NonEmptyString,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true })
});

export type TraceRecord = z.infer<typeof TraceRecordSchema>;
