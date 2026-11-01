import { z } from "zod";

/** Content-free, host-owned annotation of a committed display story. */
export const storyOperationFailuresSchema = z
  .object({ count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

export type StoryOperationFailures = z.infer<
  typeof storyOperationFailuresSchema
>;

/** Select only the validated host field, never arbitrary message metadata. */
export function projectStoryOperationFailures(message: {
  readonly role: string;
  readonly kind?: unknown;
  readonly operationFailures?: unknown;
}): { operationFailures?: StoryOperationFailures } {
  if (message.role !== "assistant" || message.kind !== "story") return {};
  const parsed = storyOperationFailuresSchema.safeParse(
    message.operationFailures,
  );
  return parsed.success
    ? { operationFailures: { count: parsed.data.count } }
    : {};
}
