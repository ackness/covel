import { assertAgentOutputObjectSchema } from "@covel/shared/plugin-runtime";
import { proposalReadScopesSchema } from "@covel/shared";
import {
  orchestrationSettingsSchema,
  delegationSnapshotSchema,
} from "@covel/shared";
import { z } from "zod";
import {
  turnActionSchema,
  autoAdvanceLimitSchema,
  characterSchemaRecordSchema,
  seatsSchema,
} from "@covel/shared";
import {
  characters,
  createdRow,
  executionOrigin,
  jsonObject,
  jsonValue,
  lorebookEntries,
  nonEmptyString,
  pluginData,
  sessionSummaries,
  timestamp,
} from "./checkpoint-record-schemas.js";

const setupStateFields = {
  pluginVersion: z.string(),
  generation: z.number(),
  attempts: z.number(),
};
const setupRuntimeState = z.discriminatedUnion("state", [
  z.looseObject({
    ...setupStateFields,
    state: z.literal("pending"),
    lastError: z.string().optional(),
  }),
  z.looseObject({
    ...setupStateFields,
    state: z.literal("done"),
    resolution: z.enum(["completed", "waived"]),
    completedAt: timestamp,
    warning: z.string().optional(),
  }),
  z.looseObject({
    ...setupStateFields,
    state: z.literal("blocked"),
    reason: z.string(),
    blockedAt: timestamp,
  }),
]);
const suspensionWriteBaseline = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("plugin-data"),
      pluginId: z.string(),
      namespace: z.string(),
      key: z.string(),
    }),
    z.object({ kind: z.literal("character"), id: z.string() }),
    z.object({ kind: z.literal("character-schema") }),
    z.object({
      kind: z.literal("lorebook"),
      pluginId: z.string(),
      id: z.string(),
    }),
  ]),
  digest: z.string().nullable(),
});
const sessionState = z.looseObject({
  status: z.enum(["active", "paused", "ended"]),
  phase: z.enum(["setup", "playing"]),
  completedPlayerTurns: z.number().int().nonnegative(),
  setupRuntimes: z.record(z.string(), setupRuntimeState),
  seats: seatsSchema,
  locale: nonEmptyString,
  activePlugins: z.array(z.string()),
  runtimeModelOverrides: z.record(z.string(), z.string()).optional(),
});
const snapshotSession = sessionState.extend({
  autoAdvanceLimit: autoAdvanceLimitSchema.optional(),
  loreOverride: z.string().optional(),
  orchestration: orchestrationSettingsSchema.optional(),
});
export const session = sessionState.extend({
  id: nonEmptyString,
  worldId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: jsonObject
    .superRefine((metadata, ctx) => {
      if (metadata.orchestration === undefined) return;
      const parsed = orchestrationSettingsSchema.safeParse(
        metadata.orchestration,
      );
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ ...issue, path: ["orchestration", ...issue.path] });
    })
    .and(z.object({ autoAdvanceLimit: autoAdvanceLimitSchema.optional() }))
    .optional(),
  embeddingModelId: z.number().nullable().optional(),
  embeddingLockedAt: timestamp.nullable().optional(),
});

const inputSource = z.object({
  pluginId: nonEmptyString,
  runtimeId: nonEmptyString,
  resultId: nonEmptyString,
});
const inputSlots = z.record(
  z.string(),
  z.discriminatedUnion("cardinality", [
    z.object({
      cardinality: z.literal("one"),
      value: jsonValue,
      source: inputSource,
    }),
    z.object({
      cardinality: z.literal("all"),
      items: z.array(z.object({ value: jsonValue, source: inputSource })),
    }),
  ]),
);

const correctionCount = z.number().int().nonnegative();
const suspendedLoopState = z.strictObject({
  steps: correctionCount,
  maxSteps: z.number().int().positive(),
  rejectionAttempts: correctionCount,
  correctionLimits: z.strictObject({
    toolUse: correctionCount,
    review: correctionCount,
    loopPerturbation: correctionCount,
    outputRepair: correctionCount,
  }),
  outputContract: z
    .strictObject({
      toolName: z.literal("submit-output"),
      schema: jsonObject.superRefine((schema, ctx) => {
        try {
          assertAgentOutputObjectSchema(schema);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Agent output schema requires an object root",
          });
        }
      }),
      schemaSource: z.enum(["loaded", "host-story", "host-system"]),
      provenance: z.enum(["model-authored", "tool-result"]),
      from: z.strictObject({ tool: nonEmptyString }).optional(),
      requiredWork: z.strictObject({
        required: z.boolean(),
        toolNames: z.array(nonEmptyString),
      }),
    })
    .refine(
      (output) =>
        (output.provenance === "tool-result") === (output.from !== undefined),
      {
        message: "Only tool-result output requires a source tool",
        path: ["from"],
      },
    ),
  corrections: z
    .strictObject({
      toolUse: correctionCount.optional(),
      review: correctionCount.optional(),
      loopPerturbation: correctionCount.optional(),
      outputRepair: correctionCount.optional(),
    })
    .optional(),
  activatedTools: z.array(nonEmptyString).optional(),
});
const jobOwnership = z.strictObject({
  runId: nonEmptyString,
  attemptId: nonEmptyString,
  settled: z.boolean(),
});
const jobData = jsonValue.superRefine((value, context) => {
  if (
    value &&
    typeof value === "object" &&
    "_covel" in value &&
    !jobOwnership.safeParse(value._covel).success
  )
    context.addIssue({
      code: "custom",
      path: ["_covel"],
      message: "Invalid kernel job ownership",
    });
});
const suspendedNestedResult = z.strictObject({
  readScopes: proposalReadScopesSchema,
  operationReadScopes: z
    .record(z.string(), proposalReadScopesSchema)
    .optional(),
  result: z.looseObject({
    pluginId: nonEmptyString,
    runtimeId: nonEmptyString,
    runId: nonEmptyString,
    turnId: z.string(),
    status: z.string(),
  }),
  journal: z.array(jsonValue).optional(),
  trigger: nonEmptyString.optional(),
});

const suspensions = createdRow.extend({
  turnId: z.string(),
  runtimeId: z.string(),
  pluginId: z.string(),
  reason: z.string(),
  resumeSchema: jsonValue,
  pendingContinuation: z
    .strictObject({
      lifecycle: z.strictObject({
        runId: nonEmptyString,
        progressRunId: nonEmptyString,
      }),
      delegation: delegationSnapshotSchema.optional(),
      messages: z.array(jsonValue),
      toolCallsSoFar: z.array(jsonValue),
      businessCalls: z
        .array(
          z.strictObject({
            name: nonEmptyString,
            success: z.boolean(),
            result: jsonValue,
          }),
        )
        .optional(),
      pendingProposals: z.array(jsonValue),
      readScopes: proposalReadScopesSchema,
      inputSlots: inputSlots.optional(),
      exportSlots: inputSlots.optional(),
      activation: z
        .object({
          source: z.enum(["stage", "event", "manual"]),
          detached: z.boolean(),
          payload: jsonValue,
        })
        .optional(),
      executionContext: z.looseObject({
        executionId: nonEmptyString,
        origin: executionOrigin,
        logicalTurnId: z.string().optional(),
        logicalTurn: z.number().int().positive().optional(),
        sourceTurnId: z.string().optional(),
        countPolicy: z.enum(["none", "complete-player-turn"]),
      }),
      progressScopeId: nonEmptyString.optional(),
      takenUnder: z.object({
        playerTurns: z.number().int().nonnegative(),
        pluginVersion: z.string(),
        writes: z.array(suspensionWriteBaseline),
      }),
      locale: z.string().optional(),
      logicalTurn: z.number().int().optional(),
      actions: z.array(turnActionSchema).optional(),
      turnNumber: z.number().int().optional(),
      currentTurnUserMessages: z.number().int().positive().optional(),
      emittedEvents: z.array(jsonValue).optional(),
      suspendToolCallId: z.string().optional(),
      loop: suspendedLoopState.optional(),
      withheldRuntimeJobs: z.array(jsonValue).optional(),
      promptSegments: z
        .array(z.strictObject({ pluginId: z.string(), id: z.string() }))
        .optional(),
      nestedResults: z.array(suspendedNestedResult).optional(),
    })
    .superRefine((continuation, ctx) => {
      if (continuation.suspendToolCallId && !continuation.loop)
        ctx.addIssue({
          code: "custom",
          path: ["loop"],
          message:
            "Active agent continuation requires its admitted output contract and budget",
        });
      if (
        continuation.loop &&
        continuation.loop.steps > continuation.loop.maxSteps
      )
        ctx.addIssue({
          code: "custom",
          path: ["loop", "steps"],
          message: "Spent steps exceed the admitted limit",
        });
    }),
  // All backends use a timestamp-prefixed claim marker while resume is active.
  resolvedAt: z
    .union([
      timestamp,
      z
        .string()
        .refine(
          (value) =>
            value.startsWith("claimed:") &&
            timestamp.safeParse(value.slice(8)).success,
        ),
    ])
    .optional(),
});

const runtimeExport = z.looseObject({
  sessionId: nonEmptyString,
  producerPluginId: z.string(),
  producerRuntimeId: z.string(),
  recordAs: z.string(),
  revision: z.number(),
  pluginVersion: z.string(),
  schemaDigest: z.string(),
  resultId: z.string(),
  value: jsonValue,
  committedAt: timestamp,
});

export const snapshotRecordArrays = {
  characters: z.array(characters),
  runtimeExports: z.array(runtimeExport),
  pluginData: z.array(pluginData),
  sessionSummaries: z.array(sessionSummaries),
  lorebookEntries: z.array(lorebookEntries),
  suspensions: z.array(suspensions),
};

export const snapshotPayloadSchema = z
  .looseObject({
    schemaVersion: z.literal(3),
    turnId: z.string(),
    session: snapshotSession,
    ...snapshotRecordArrays,
    characterSchema: characterSchemaRecordSchema.nullable(),
    compactedMessageSummaryIds: z.record(z.string(), z.string()),
    messagesCursor: z.string(),
    displayMessagesBoundary: z
      .object({
        createdAt: timestamp,
        ids: z.array(nonEmptyString).min(1),
      })
      .nullable(),
  })
  .superRefine((payload, ctx) => {
    const summaries = new Set(
      payload.sessionSummaries.map((summary) => summary.id),
    );
    for (const [messageId, summaryId] of Object.entries(
      payload.compactedMessageSummaryIds,
    )) {
      if (!summaries.has(summaryId))
        ctx.addIssue({
          code: "custom",
          path: ["compactedMessageSummaryIds", messageId],
          message: "must reference a captured session summary",
        });
    }
  });

export const checkpointLifecycleArrays = {
  suspensions: z.array(suspensions),
  snapshots: z.array(
    createdRow.extend({
      turnId: z.string(),
      kind: z.enum(["auto", "manual", "fork"]),
      parentId: z.string().optional(),
      payload: snapshotPayloadSchema,
    }),
  ),
  logicalTurnLedger: z.array(
    z.looseObject({
      sessionId: nonEmptyString,
      logicalTurnId: z.string(),
      completedByExecutionId: z.string(),
      completedAt: timestamp,
    }),
  ),
  setupAttempts: z.array(
    z.looseObject({
      sessionId: nonEmptyString,
      runtimeId: z.string(),
      pluginVersion: z.string(),
      generation: z.number(),
      executionId: z.string(),
      state: z.enum(["started", "success", "failed", "skipped", "suspended"]),
      startedAt: timestamp,
      finishedAt: timestamp.optional(),
      error: z.string().optional(),
    }),
  ),
  jobStatus: z.array(
    z.looseObject({
      sessionId: nonEmptyString,
      progressScopeId: z.string(),
      pluginId: z.string(),
      runtimeId: z.string(),
      jobId: z.string(),
      state: z.enum([
        "queued",
        "running",
        "progress",
        "waiting-input",
        "succeeded",
        "failed",
        "cancelled",
      ]),
      progress: z.number().optional(),
      message: z.string().optional(),
      data: jobData.optional(),
      sequence: z.number(),
      createdAt: timestamp,
    }),
  ),
  runtimeExports: z.array(runtimeExport),
};
