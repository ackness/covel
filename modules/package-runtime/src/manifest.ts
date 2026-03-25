import { z } from "zod";

const NonEmptyString = z.string().min(1);
const RelativePackagePath = z.string().min(1);

const ContextProviderContributionSchema = z.object({
  id: NonEmptyString,
  entry: RelativePackagePath,
  reads: z.array(NonEmptyString),
  writes: z.array(NonEmptyString)
});

const CommandContributionSchema = z.object({
  name: NonEmptyString,
  description: NonEmptyString,
  argsSchema: RelativePackagePath,
  entry: RelativePackagePath,
  resume: z.boolean()
});

const HookContributionSchema = z.object({
  id: NonEmptyString,
  phase: NonEmptyString,
  trigger: z.record(z.string(), z.unknown()).optional(),
  entry: RelativePackagePath
});

const CapabilityContributionSchema = z.object({
  id: NonEmptyString,
  type: z.enum(["builtin", "script", "model", "workflow", "job"]),
  entry: RelativePackagePath,
  inputSchema: RelativePackagePath,
  outputSchema: RelativePackagePath,
  timeoutMs: z.number().int().positive().optional()
});

const BlockTypeContributionSchema = z.object({
  type: NonEmptyString,
  dataSchema: RelativePackagePath,
  responseSchema: RelativePackagePath,
  resume: z.object({
    handler: NonEmptyString
  }).optional(),
  ui: z.object({
    component: z.literal("schema"),
    renderer: NonEmptyString
  })
});

const RendererContributionSchema = z.object({
  name: NonEmptyString,
  entry: RelativePackagePath
});

const ArtifactTypeContributionSchema = z.object({
  type: NonEmptyString,
  kind: NonEmptyString,
  mediaType: NonEmptyString
});

const PackageSettingSchema = z.object({
  key: NonEmptyString,
  type: NonEmptyString,
  default: z.unknown().optional(),
  scope: NonEmptyString
});

const PackageStateSchema = z.object({
  collection: NonEmptyString,
  scope: NonEmptyString,
  schema: RelativePackagePath
});

const PackageContributesSchema = z.object({
  context: z.array(ContextProviderContributionSchema).optional(),
  contextProviders: z.array(ContextProviderContributionSchema).optional(),
  commands: z.array(CommandContributionSchema).default([]),
  hooks: z.array(HookContributionSchema).default([]),
  capabilities: z.array(CapabilityContributionSchema).default([]),
  blocks: z.array(BlockTypeContributionSchema).optional(),
  blockTypes: z.array(BlockTypeContributionSchema).optional(),
  renderers: z.array(RendererContributionSchema).default([]),
  artifactTypes: z.array(ArtifactTypeContributionSchema).default([])
});

export const PackageManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  name: NonEmptyString,
  version: NonEmptyString,
  description: NonEmptyString,
  kind: NonEmptyString.optional(),
  defaultEnabled: z.boolean().optional(),
  scopes: z.array(NonEmptyString),
  permissions: z.array(NonEmptyString),
  dependencies: z.array(NonEmptyString).optional(),
  modelPolicy: z.object({
    preferredTier: NonEmptyString
  }),
  contributes: PackageContributesSchema,
  runtime: z.record(z.string(), z.unknown()).optional(),
  settings: z.array(PackageSettingSchema).default([]),
  state: z.array(PackageStateSchema).default([])
}).transform((manifest) => {
  const contextProviders = manifest.contributes.contextProviders ?? manifest.contributes.context ?? [];
  const blockTypes = manifest.contributes.blockTypes ?? manifest.contributes.blocks ?? [];

  return {
    ...manifest,
    contributes: {
      context: contextProviders,
      contextProviders,
      commands: manifest.contributes.commands,
      hooks: manifest.contributes.hooks,
      capabilities: manifest.contributes.capabilities,
      blocks: blockTypes,
      blockTypes,
      renderers: manifest.contributes.renderers,
      artifactTypes: manifest.contributes.artifactTypes
    }
  };
});

export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export type ContextContribution = z.infer<typeof ContextProviderContributionSchema>;
export type ContextProviderContribution = z.infer<typeof ContextProviderContributionSchema>;
export type CommandContribution = z.infer<typeof CommandContributionSchema>;
export type HookContribution = z.infer<typeof HookContributionSchema>;
export type CapabilityContribution = z.infer<typeof CapabilityContributionSchema>;
export type BlockContribution = z.infer<typeof BlockTypeContributionSchema>;
export type BlockTypeContribution = z.infer<typeof BlockTypeContributionSchema>;
export type RendererContribution = z.infer<typeof RendererContributionSchema>;
export type ArtifactTypeContribution = z.infer<typeof ArtifactTypeContributionSchema>;
export type PackageSetting = z.infer<typeof PackageSettingSchema>;
export type PackageState = z.infer<typeof PackageStateSchema>;
