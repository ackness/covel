import { z } from "zod";
import { PRESENTATION_REASONS } from "@covel/plugin-handlers-utils";

export const presentationBudgetSchema = z.strictObject({
  calls: z
    .number()
    .int()
    .min(0)
    .max(16)
    .describe(
      "Maximum admitted gateway dispatches per source turn and runtime, shared across retries; omitted means zero.",
    )
    .optional(),
  generations: z
    .number()
    .int()
    .min(0)
    .max(4)
    .describe(
      "Maximum media output units per source turn and runtime, in addition to calls; omitted means zero.",
    )
    .optional(),
});

export const presentationSchema = z
  .strictObject({
    budget: presentationBudgetSchema
      .describe(
        "Durable source-turn allowance; cache hits and availability probes cost zero.",
      )
      .optional(),
  })
  .describe(
    "Function-only public-story presentation. Omitted budget counters are zero; a positive budget requires detached, non-settling execution.",
  );

const namespaceSchema = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

export const compiledPresentationSchema = presentationSchema.extend({
  publicAssetNamespaces: z
    .array(namespaceSchema)
    .optional()
    .describe(
      "Public asset namespaces derived by the loader from the owning package's data declarations.",
    ),
});

export const presentationReasonSchema = z.enum(PRESENTATION_REASONS);

const usageCounter = z.strictObject({
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});
const completionBase = z.strictObject({
  pluginId: z.string().min(1),
  runtimeId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  sourceExecutionId: z.string().min(1),
  runId: z.string().optional(),
  jobId: z.string().optional(),
  turnId: z.string().optional(),
  budget: z.strictObject({ calls: usageCounter, generations: usageCounter }),
});
/** Content-free terminal payload; no-output statuses always explain why. */
export const presentationCompletionSchema = z.discriminatedUnion("status", [
  completionBase.extend({ status: z.literal("updated") }),
  completionBase.extend({
    status: z.literal("no-op"),
    reason: presentationReasonSchema,
  }),
  completionBase.extend({
    status: z.literal("failed"),
    reason: presentationReasonSchema,
  }),
]);
export type PresentationCompletion = z.infer<
  typeof presentationCompletionSchema
>;

/** Explicit allowlist: StoryOutput also accepts private business fields. */
export const presentationStorySchema = z.strictObject({
  segments: z
    .array(
      z.strictObject({
        kind: z.enum(["narration", "dialogue", "action"]),
        speaker: z.string().optional(),
        text: z.string().min(1),
      }),
    )
    .min(1),
  cues: z
    .strictObject({
      scene: z.string().optional(),
      present: z.array(z.string()).optional(),
      mood: z.string().optional(),
    })
    .optional(),
});

export const presentationCharacterSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
});

const limitsSchema = z.strictObject({
  calls: z.number().int().min(0).max(16),
  generations: z.number().int().min(0).max(4),
});

export const MAX_PRESENTATION_SNAPSHOT_BYTES = 256 * 1024;

/** Host-owned source, shared by the producer, persisted jobs and worker. */
export const presentationSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    committed: z.boolean(),
    sourceTurnId: z.string().min(1),
    sourceExecutionId: z.string().min(1),
    incarnation: z.string().min(1).optional(),
    pluginId: z.string().min(1),
    runtimeId: z.string().min(1),
    locale: z.string().optional(),
    limits: limitsSchema,
    story: presentationStorySchema.optional(),
    characters: z.array(presentationCharacterSchema).max(100),
    viewpointCharacterId: z.string().optional(),
    data: z.record(
      namespaceSchema,
      z
        .array(
          z.strictObject({
            key: z.string(),
            value: z.json(),
          }),
        )
        .max(50),
    ),
    /** Complete destination rows, including revisions; absent keys stay absent. */
    baselines: z.record(
      namespaceSchema,
      z
        .array(
          z.strictObject({
            key: z.string(),
            value: z.json(),
            updatedAt: z.string(),
          }),
        )
        .max(50),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.committed && !value.story)
      ctx.addIssue({
        code: "custom",
        path: ["story"],
        message:
          "A committed presentation snapshot requires public story segments",
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_PRESENTATION_SNAPSHOT_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Presentation snapshot exceeds 256 KiB",
      });
  });

export type PresentationSnapshot = z.infer<typeof presentationSnapshotSchema>;
