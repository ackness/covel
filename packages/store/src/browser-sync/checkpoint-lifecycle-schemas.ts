import { z } from "zod";
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
  stateEntries,
  timestamp,
  workingMemory,
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
const snapshotSession = z.looseObject({
  status: z.enum(["active", "paused", "ended"]),
  phase: z.enum(["setup", "playing"]),
  completedPlayerTurns: z.number().int().nonnegative(),
  setupRuntimes: z.record(z.string(), setupRuntimeState),
  locale: nonEmptyString,
  activePlugins: z.array(z.string()),
  presetId: z.string().optional(),
  runtimeModelOverrides: z.record(z.string(), z.string()).optional(),
});
export const session = snapshotSession.extend({
  id: nonEmptyString,
  worldId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: jsonObject.optional(),
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

const suspensions = createdRow.extend({
  turnId: z.string(),
  runtimeId: z.string(),
  pluginId: z.string(),
  reason: z.string(),
  resumeSchema: jsonValue,
  pendingContinuation: z.looseObject({
    messages: z.array(jsonValue),
    partialContent: z.string().optional(),
    toolCallsSoFar: z.array(jsonValue),
    pendingProposals: z.array(jsonValue),
    inputSlots: inputSlots.optional(),
    executionContext: z.looseObject({
      executionId: nonEmptyString,
      origin: executionOrigin,
      logicalTurnId: z.string().optional(),
      countPolicy: z.enum(["none", "complete-player-turn"]),
    }),
    emittedEvents: z.array(jsonValue).optional(),
    suspendToolCallId: z.string().optional(),
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

export const snapshotRecordArrays = {
  characters: z.array(characters),
  stateEntries: z.array(stateEntries),
  pluginData: z.array(pluginData),
  workingMemory: z.array(workingMemory),
  sessionSummaries: z.array(sessionSummaries).optional(),
  lorebookEntries: z.array(lorebookEntries),
  suspensions: z.array(suspensions),
};

export const checkpointLifecycleArrays = {
  suspensions: z.array(suspensions),
  snapshots: z.array(
    createdRow.extend({
      turnId: z.string(),
      kind: z.enum(["auto", "manual", "fork"]),
      parentId: z.string().optional(),
      payload: z.looseObject({
        schemaVersion: z.literal(3),
        turnId: z.string(),
        session: snapshotSession,
        ...snapshotRecordArrays,
        compactedMessageSummaryIds: z.record(z.string(), z.string()).optional(),
        messagesCursor: z.string(),
      }),
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
      data: jsonValue.optional(),
      sequence: z.number(),
      createdAt: timestamp,
    }),
  ),
  runtimeExports: z.array(
    z.looseObject({
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
    }),
  ),
};
