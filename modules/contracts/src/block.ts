import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const JsonObject = z.record(z.string(), z.unknown());

const BlockMetaSchema = z.object({
  package: NonEmptyString,
  requestId: NonEmptyString,
  traceId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: NonEmptyString
});

const BlockInteractionSchema = z
  .object({
    requiresResponse: z.boolean(),
    responseSchema: NonEmptyString.optional(),
    submitAs: NonEmptyString.optional(),
    resumePolicy: NonEmptyString.optional()
  })
  .superRefine((value, context) => {
    if (!value.requiresResponse) {
      return;
    }

    if (!value.responseSchema) {
      context.addIssue({
        code: "custom",
        message: "Interactive blocks must declare responseSchema."
      });
    }

    if (!value.submitAs) {
      context.addIssue({
        code: "custom",
        message: "Interactive blocks must declare submitAs."
      });
    }

    if (!value.resumePolicy) {
      context.addIssue({
        code: "custom",
        message: "Interactive blocks must declare resumePolicy."
      });
    }
  });

export const BlockEnvelopeSchema = z.object({
  id: NonEmptyString,
  type: NonEmptyString,
  version: NonEmptyString,
  meta: BlockMetaSchema,
  interaction: BlockInteractionSchema,
  data: JsonObject
});

export const BlockResponseSchema = z.object({
  blockId: NonEmptyString,
  blockType: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  response: JsonObject
});

export type BlockEnvelope = z.infer<typeof BlockEnvelopeSchema>;
export type BlockResponse = z.infer<typeof BlockResponseSchema>;
