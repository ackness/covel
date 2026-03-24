import { z } from "zod";

const NonEmptyString = z.string().min(1);
const RelativePackagePath = z.string().min(1);

const ContextContributionSchema = z.object({
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

const BlockContributionSchema = z.object({
  type: NonEmptyString,
  dataSchema: RelativePackagePath,
  responseSchema: RelativePackagePath,
  ui: z.object({
    component: z.literal("schema"),
    renderer: NonEmptyString
  })
});

const RendererContributionSchema = z.object({
  name: NonEmptyString,
  entry: RelativePackagePath
});

export const PackageManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  name: NonEmptyString,
  version: NonEmptyString,
  description: NonEmptyString,
  scopes: z.array(NonEmptyString),
  permissions: z.array(NonEmptyString),
  modelPolicy: z.object({
    preferredTier: NonEmptyString
  }),
  contributes: z.object({
    context: z.array(ContextContributionSchema),
    commands: z.array(CommandContributionSchema),
    blocks: z.array(BlockContributionSchema),
    renderers: z.array(RendererContributionSchema)
  })
});

export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export type ContextContribution = z.infer<typeof ContextContributionSchema>;
export type CommandContribution = z.infer<typeof CommandContributionSchema>;
export type BlockContribution = z.infer<typeof BlockContributionSchema>;
export type RendererContribution = z.infer<typeof RendererContributionSchema>;
