import { isJsonValue, type JsonValue } from "@covel/shared";
import { z } from "zod";

export const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "must be a non-empty string",
  });
export const timestamp = nonEmptyString.refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a valid timestamp" },
);
export const jsonValue = z.custom<JsonValue>(isJsonValue, {
  message: "must be a JSON-serialisable value",
});
export const jsonObject = z.record(z.string(), jsonValue);
export const sessionRow = z.looseObject({
  id: nonEmptyString,
  sessionId: nonEmptyString,
});
export const createdRow = sessionRow.extend({ createdAt: timestamp });
export const executionOrigin = z.enum([
  "player",
  "continuation",
  "manual",
  "background",
  "recursive",
  "resume",
]);

export const stateSchemas = createdRow.extend({
  tableName: z.string(),
  schema: jsonValue,
});
export const stateEntries = sessionRow.extend({
  tableName: z.string(),
  fieldName: z.string(),
  value: jsonValue,
  updatedAt: timestamp,
});
export const stateChanges = createdRow.extend({
  tableName: z.string(),
  fieldName: z.string(),
  value: jsonValue,
  changedBy: z.string(),
  turnId: z.string(),
  reason: z.string().optional(),
});
export const characters = createdRow.extend({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  fields: jsonValue.optional(),
  version: z.number(),
  updatedAt: timestamp,
});
export const pluginData = createdRow.extend({
  pluginId: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: jsonValue,
  updatedAt: timestamp,
});
export const workingMemory = sessionRow.extend({
  key: z.string(),
  scope: z.enum(["player", "story", "shared"]),
  value: jsonValue,
  schemaRef: z.string().optional(),
  updatedAt: timestamp,
});
export const lorebookEntries = createdRow.extend({
  pluginId: z.string(),
  keys: z.array(z.string()),
  content: z.string(),
  strategy: z.enum(["constant", "selective"]),
  position: z.string(),
  insertionOrder: z.number(),
  enabled: z.boolean(),
  extra: jsonValue.optional(),
  updatedAt: timestamp,
});
export const sessionSummaries = createdRow.extend({
  turnRangeStart: z.string(),
  turnRangeEnd: z.string(),
  content: z.string(),
  focusSections: z.array(z.string()),
});

/** Store JSON fields remain opaque; typed record fields are validated here. */
export const checkpointRecordArrays = {
  messages: z.array(
    createdRow.extend({
      role: z.string(),
      content: z.string(),
      metadata: jsonValue.optional(),
    }),
  ),
  turnMessages: z.array(
    createdRow.extend({
      turnId: z.string(),
      sourceType: z.string(),
      sourcePluginId: z.string().optional(),
      sourceRuntimeId: z.string().optional(),
      role: z.string(),
      name: z.string().optional(),
      content: z.string(),
      ui: jsonValue.optional(),
      pendingInput: jsonValue.optional(),
      order: z.number(),
      compactedAtTurnId: z.string().optional(),
    }),
  ),
  turnResults: z.array(
    createdRow.extend({
      turnId: z.string(),
      runtimeResults: jsonValue,
      conflicts: jsonValue.optional(),
      auditResult: jsonValue.optional(),
      origin: executionOrigin,
      parentTurnId: z.string().optional(),
      commitStatus: z.enum(["pending", "committed", "failed"]),
      durationMs: z.number(),
    }),
  ),
  runtimeResults: z.array(
    createdRow.extend({
      turnId: z.string(),
      pluginId: z.string(),
      runtimeId: z.string(),
      status: z.string(),
      output: jsonValue,
      toolCalls: jsonValue,
      durationMs: z.number(),
      tokenUsage: jsonValue.optional(),
      error: z.string().optional(),
    }),
  ),
  toolCalls: z.array(
    createdRow.extend({
      turnId: z.string(),
      toolName: z.string(),
      pluginId: z.string(),
      runtimeId: z.string(),
      input: jsonValue,
      output: jsonValue,
      durationMs: z.number(),
      approvalStatus: z.string(),
    }),
  ),
  runtimeOutputs: z.array(
    createdRow.extend({
      turnId: z.string(),
      runtimeResultId: z.string().optional(),
      pluginId: z.string(),
      runtimeId: z.string(),
      timestamp,
      results: jsonValue,
      metaData: jsonValue,
    }),
  ),
  interactions: z.array(
    createdRow.extend({
      turnId: z.string().optional(),
      timestamp,
      source: z.string(),
      channel: z.string(),
      type: z.string(),
      targetPluginId: z.string().optional(),
      targetRuntimeId: z.string().optional(),
      payload: jsonValue,
      metaData: jsonValue.optional(),
    }),
  ),
  events: z.array(
    createdRow.extend({
      type: z.string(),
      topic: z.string(),
      payload: jsonValue,
      targetRuntime: z.string().optional(),
      turnId: z.string().optional(),
    }),
  ),
  traceEvents: z.array(
    createdRow.extend({
      type: z.string(),
      traceId: z.string(),
      turnId: z.string(),
      payload: jsonValue,
    }),
  ),
  characters: z.array(characters),
  pluginData: z.array(pluginData),
  workingMemory: z.array(workingMemory),
  lorebookEntries: z.array(lorebookEntries),
  sessionSummaries: z.array(sessionSummaries),
  playerInputs: z.array(
    createdRow.extend({
      turnId: z.string(),
      formId: z.string(),
      values: jsonValue,
    }),
  ),
  worldDataLedger: z.array(
    sessionRow.extend({
      target: z.string(),
      pluginId: z.string().optional(),
      namespace: z.string().optional(),
      key: z.string().optional(),
      sourceWorldId: z.string(),
      sourceId: z.string(),
      sourceDigest: z.string(),
      valueHash: z.string(),
      schemaRef: z.string().optional(),
      derivedFrom: z.array(z.string()).optional(),
      importedAt: timestamp,
      managed: z.boolean(),
    }),
  ),
};
