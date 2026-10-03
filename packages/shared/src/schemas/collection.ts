import { z } from "zod";
import { hostVersionRangeSchema } from "../utils/host-version-range.js";
import { githubPluginPreviewSchema } from "./plugin-install.js";
import { i18nTextSchema } from "./world.js";

/** File name of a collection manifest, at the root of the collection. */
export const COLLECTION_MANIFEST_FILE = "covel-collection.yaml";

/** A collection installs at most this many packages, like one preview. */
export const COLLECTION_MEMBER_LIMIT = 20;

const memberPathSchema = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (part) =>
            /^[a-z0-9_.-]+$/i.test(part) && part !== "." && part !== "..",
        ),
    { message: "must be a relative path without . or .. segments" },
  );

/** A package in the collection's own repository, at the collection's commit. */
const localMemberSchema = z.object({ path: memberPathSchema }).strict();

/**
 * A package in another repository. The full commit SHA is required: a
 * collection is a lockfile, so what it installs never moves under the author.
 */
const externalMemberSchema = z
  .object({
    repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/i, {
      message: 'must be "owner/repo"',
    }),
    commit: z.string().regex(/^[a-f0-9]{40}$/, {
      message: "must be a full 40-character commit SHA",
    }),
    path: memberPathSchema.optional(),
  })
  .strict();

const memberSchema = z.union([localMemberSchema, externalMemberSchema]);

/**
 * covel-collection.yaml: a pointer list. It installs ordinary plugins and
 * ordinary worlds and adds no runtime concept of its own.
 */
export const collectionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, {
      message: "must be lowercase letters, digits and hyphens",
    }),
    name: i18nTextSchema,
    description: i18nTextSchema.optional(),
    version: z.string().max(100).optional(),
    covel: hostVersionRangeSchema.optional(),
    worlds: z.array(memberSchema).default([]),
    plugins: z.array(memberSchema).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const count = manifest.worlds.length + manifest.plugins.length;
    if (count === 0)
      ctx.addIssue({
        code: "custom",
        message: "a collection lists at least one world or plugin",
      });
    if (count > COLLECTION_MEMBER_LIMIT)
      ctx.addIssue({
        code: "custom",
        message: `a collection lists at most ${COLLECTION_MEMBER_LIMIT} packages`,
      });
  });

export type CollectionManifest = z.infer<typeof collectionManifestSchema>;
export type CollectionMember = z.infer<typeof memberSchema>;

export const githubPackagePreviewSchema = githubPluginPreviewSchema.extend({
  kind: z.enum(["plugin", "world"]),
});
export type GithubPackagePreview = z.infer<typeof githubPackagePreviewSchema>;

export const collectionProblemSchema = z
  .object({
    level: z.enum(["error", "warning"]),
    message: z.string(),
    /** The world or plugin the problem is about, when it concerns one. */
    packageId: z.string().optional(),
  })
  .strict();
export type CollectionProblem = z.infer<typeof collectionProblemSchema>;

/** One preview of everything installable under a GitHub URL. */
export const githubCollectionPreviewSchema = z
  .object({
    collection: z
      .object({
        id: z.string(),
        name: i18nTextSchema,
        version: z.string().nullable(),
      })
      .strict()
      .nullable(),
    items: z.array(githubPackagePreviewSchema),
    problems: z.array(collectionProblemSchema),
  })
  .strict();
export type GithubCollectionPreview = z.infer<
  typeof githubCollectionPreviewSchema
>;

export const githubBatchInstallRequestSchema = z
  .object({
    tokens: z
      .array(z.string().min(1).max(8192))
      .min(1)
      .max(COLLECTION_MEMBER_LIMIT),
    acceptRisk: z.literal(true),
  })
  .strict();

export const githubBatchInstallResultSchema = z
  .object({
    ok: z.literal(true),
    installed: z.array(
      z.object({ kind: z.enum(["plugin", "world"]), id: z.string() }).strict(),
    ),
    restartRequired: z.boolean(),
  })
  .strict();
export type GithubBatchInstallResult = z.infer<
  typeof githubBatchInstallResultSchema
>;
