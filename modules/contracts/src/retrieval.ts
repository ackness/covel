import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const RetrievalRunSchema = z.object({
  id: NonEmptyString,
  sessionId: NonEmptyString,
  query: NonEmptyString,
  rewrittenQueries: z.array(NonEmptyString),
  selectedSources: z.array(NonEmptyString),
  candidates: z.array(
    z.object({
      chunkId: NonEmptyString,
      score: z.number()
    })
  ),
  selectedChunks: z.array(
    z.object({
      chunkId: NonEmptyString,
      documentId: NonEmptyString
    })
  ),
  critique: z.record(z.string(), z.unknown()),
  latencyMs: z.number().nonnegative()
});

export type RetrievalRun = z.infer<typeof RetrievalRunSchema>;
