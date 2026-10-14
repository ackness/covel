import { z } from "zod";

const text = z.string().min(1);
const data = z.record(z.string(), z.unknown());

export const caseExpectationsSchema = z.strictObject({
  runtimeResults: z
    .array(
      z.strictObject({
        runtimeId: text
          .describe("Runtime to match; omitted matches any runtime.")
          .optional(),
        status: z
          .enum([
            "pending",
            "running",
            "success",
            "failed",
            "skipped",
            "suspended",
          ])
          .describe("Required runtime result status."),
        errorIncludes: text
          .describe("Substring required in the runtime error.")
          .optional(),
      }),
    )
    .describe("Runtime results that must exist.")
    .optional(),
  events: z
    .array(text)
    .describe("Event topics that must be emitted.")
    .optional(),
  logs: z
    .array(text)
    .describe("Plugin log messages that must exist.")
    .optional(),
  pluginData: z
    .array(
      z.strictObject({
        namespace: text.describe("Plugin data namespace to inspect."),
        key: text.describe("Record key to match.").optional(),
        status: text
          .describe("Required value of the record's status field.")
          .optional(),
        field: text.describe("Field that must exist on the record.").optional(),
      }),
    )
    .describe("Committed plugin data records that must exist.")
    .optional(),
  assetGenerations: z
    .array(
      z.strictObject({
        modality: text.describe("Media modality to match.").optional(),
        field: text
          .describe("Field that must exist on the generated asset.")
          .optional(),
      }),
    )
    .describe("Asset generation effects that must exist.")
    .optional(),
});

export const caseArtifactConfigSchema = z.strictObject({
  saveImages: z
    .strictObject({
      namespace: text
        .describe("Plugin data namespace containing image references.")
        .optional(),
      dir: text.describe("Directory for saved images.").optional(),
      field: text
        .describe("Record field containing the image reference.")
        .optional(),
    })
    .describe("Save generated image artifacts for inspection.")
    .optional(),
});

export const runtimeCaseSchema = z.strictObject({
  name: text.describe("Required case name, selected by --case."),
  runtimeId: text.describe("Required runtime ID to execute."),
  pluginId: text
    .describe("Package owning the runtime; defaults to the selected plugin.")
    .optional(),
  withPlugins: z
    .array(text)
    .describe("Additional plugin packages loaded for this case.")
    .optional(),
  message: z.string().describe("Player message for this execution.").optional(),
  payload: data.describe("Plugin-defined manual trigger payload.").optional(),
  userSettings: data.describe("Plugin-defined setting overrides.").optional(),
  llmResponse: data.describe("One mock model response.").optional(),
  llmResponses: z
    .array(data)
    .describe("Mock model responses in call order.")
    .optional(),
  llmContent: z.string().describe("Mock reply text shorthand.").optional(),
  llmObject: data.describe("Mock reply object shorthand.").optional(),
  mockPresetId: text
    .describe("Preset ID exposed by the mock gateway.")
    .optional(),
  ignoreUpstreams: z
    .boolean()
    .describe("Ignore upstream requirements for isolated debugging.")
    .optional(),
  expectsBackgroundFollower: z
    .boolean()
    .describe("Require a background follower to be queued.")
    .optional(),
  mode: z
    .enum(["mock", "live", "both"])
    .describe("Modes that run this case; omitted means both.")
    .optional(),
  expect: caseExpectationsSchema
    .describe("Assertions evaluated after execution.")
    .optional(),
  artifacts: caseArtifactConfigSchema
    .describe("Artifacts to save after execution.")
    .optional(),
});

export const runtimeCasesSchema = z.array(runtimeCaseSchema).min(1);
export const runtimeCaseFileSchema = z.strictObject({
  $schema: text
    .describe("Optional JSON Schema URL for editor validation.")
    .optional(),
  cases: runtimeCasesSchema.describe("Non-empty list of runtime cases."),
});

export type RuntimeCase = z.infer<typeof runtimeCaseSchema>;
export type CaseExpectations = z.infer<typeof caseExpectationsSchema>;
export type CaseArtifactConfig = z.infer<typeof caseArtifactConfigSchema>;
