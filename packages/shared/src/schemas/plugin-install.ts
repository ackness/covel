import { z } from "zod";

export const githubPluginPreviewRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
  })
  .strict();

export const githubPluginInstallRequestSchema = z
  .object({
    token: z.string().min(1).max(8192),
    acceptRisk: z.literal(true),
  })
  .strict();

export const githubPluginSourceSchema = z
  .object({
    repository: z
      .string()
      .regex(/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/i),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z
      .string()
      .refine(
        (value) =>
          value === "" ||
          value
            .split("/")
            .every(
              (part) =>
                /^[a-z0-9_.-]+$/i.test(part) && part !== "." && part !== "..",
            ),
      ),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const githubPluginPreviewSchema = z
  .object({
    id: z.string(),
    version: z.string().nullable(),
    description: z.string(),
    hasServerCode: z.boolean(),
    source: githubPluginSourceSchema,
    token: z.string(),
    expiresAt: z.number(),
  })
  .strict();

export const githubPluginPreviewsSchema = z
  .object({
    items: z.array(githubPluginPreviewSchema),
  })
  .strict();

export type GithubPluginPreview = z.infer<typeof githubPluginPreviewSchema>;

export const pluginInstallationSchema = z
  .object({
    id: z.string(),
    version: z.string().nullable(),
    source: githubPluginSourceSchema.nullable(),
  })
  .strict();
export const pluginInstallationsSchema = z
  .object({ items: z.array(pluginInstallationSchema) })
  .strict();
export type PluginInstallation = z.infer<typeof pluginInstallationSchema>;
