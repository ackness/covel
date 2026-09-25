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

export const pluginInstallIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]{0,63}$/i);
const githubRefSchema = z
  .string()
  .regex(/^[a-z0-9_./-]{1,200}$/i)
  .refine((ref) =>
    ref
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const githubPluginTrackingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default-branch") }).strict(),
  z.object({ kind: z.literal("branch"), ref: githubRefSchema }).strict(),
  z.object({ kind: z.literal("pinned"), ref: githubRefSchema }).strict(),
]);

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
    tracking: githubPluginTrackingSchema,
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
    pendingUpdate: z
      .object({
        version: z.string().nullable(),
        source: githubPluginSourceSchema,
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const pluginInstallationsSchema = z
  .object({ items: z.array(pluginInstallationSchema) })
  .strict();
export type PluginInstallation = z.infer<typeof pluginInstallationSchema>;

export const githubPluginUpdateCheckRequestSchema = z
  .object({
    id: pluginInstallIdSchema,
    url: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();
export const githubPluginUpdatePreviewSchema = githubPluginPreviewSchema
  .extend({
    previous: z
      .object({
        version: z.string().nullable(),
        source: githubPluginSourceSchema,
      })
      .strict(),
    changes: z
      .object({
        added: z.array(z.string()),
        modified: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const githubPluginUpdateCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("current") }).strict(),
  z.object({ status: z.literal("pinned") }).strict(),
  z
    .object({
      status: z.literal("available"),
      preview: githubPluginUpdatePreviewSchema,
    })
    .strict(),
]);
export type GithubPluginUpdatePreview = z.infer<
  typeof githubPluginUpdatePreviewSchema
>;
