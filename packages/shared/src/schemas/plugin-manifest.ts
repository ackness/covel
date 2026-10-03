import {
  isKernelExtensionContract,
  INVALID_KERNEL_CONFLICT,
  kernelConflictMessage,
} from "../extension-points/contracts.js";
import { z } from "zod";
import { hostVersionRangeSchema } from "../utils/host-version-range.js";
import {
  contractIdSchema,
  runtimeAuthoringManifestSchema,
} from "./runtime-manifest.js";
import {
  runtimeManifestInputSchema,
  extensionDeclarationSchema,
  hookDeclarationSchema,
  pluginDataSchemaDeclSchema,
  worldProjectionMapSchema,
} from "./plugin-schemas.js";
const shape = runtimeManifestInputSchema.shape;

/**
 * What a world author needs in order to supply one kind of world data. It
 * lives with the plugin that accepts the data, so authoring tools, skills and
 * the world generator learn about a new plugin without a central edit.
 */
const dataAuthoringSchema = z
  .strictObject({
    title: z.union([z.string().min(1), z.record(z.string(), z.string())]).meta({
      description:
        "Author-facing name of this content. Plain string or a locale map.",
      examples: ["Starting quests"],
    }),
    hint: z
      .string()
      .min(1)
      .describe(
        "How to write good records: what to include, limits, and links to other content. Read by authors and by generators.",
      )
      .optional(),
    example: z
      .string()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.json$/i, {
        message:
          "example must be a package-relative .json path (no leading `/`, no `..` segments)",
      })
      .describe(
        "Package-relative path of a JSON file with a valid example of the source value. It is validated against the namespace schema.",
      )
      .optional(),
    source: z
      .strictObject({
        kind: z
          .enum(["yaml", "json", "media"])
          .describe(
            "Reader type of the source. `media` is a directory whose index this namespace receives.",
          ),
        path: z
          .string()
          .min(1)
          .meta({
            description:
              "Conventional path of the source inside a world package.",
            examples: ["data/quests.yaml"],
          }),
        key: z
          .string()
          .min(1)
          .describe(
            "Field that gives each record a stable key. Media sources use `filename`.",
          )
          .optional(),
        visibility: z
          .enum(["public", "hidden"])
          .describe(
            "`hidden` for content the player must not see before the plugin reveals it. Defaults to `public`.",
          )
          .optional(),
        lorebook: z
          .boolean()
          .describe(
            "`true` also projects each record into the lorebook (`+lorebook`).",
          )
          .optional(),
      })
      .describe(
        "The world data source an author declares to supply this content.",
      )
      .optional(),
  })
  .describe(
    "What a world author needs to supply this content. Authoring tools and the world generator read it.",
  );
export const pluginManifestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .meta({
      description:
        "Stable package ID: lowercase letters, digits and hyphens. It must match the package directory name.",
      examples: ["dice-check"],
    }),
  kind: z
    .enum(["core", "plugin"])
    .describe(
      "Package kind. `core` marks a core plugin; other packages use `plugin`.",
    ),
  version: z
    .string()
    .describe(
      "Package version. Setup runtimes rerun for existing sessions when it changes. A package without a version counts as `0.0.0`.",
    )
    .optional(),
  // Host versions this package was written for; the installer enforces it.
  covel: hostVersionRangeSchema
    .meta({
      description:
        "Host version range this package supports. The installer enforces it.",
      examples: [">=0.0.45"],
    })
    .optional(),
  displayName: shape.displayName,
  description: shape.description,
  tags: z
    .array(
      z
        .string()
        .refine(
          (tag) => !tag.startsWith("role:"),
          "role tags are replaced by contracts",
        ),
    )
    .describe(
      "Catalogue tags such as `ui:right-panel` or `cost:llm`. `role:` tags are rejected; use contracts.",
    )
    .optional(),
  provides: z
    .array(
      z.union([
        contractIdSchema,
        z.strictObject({
          contract: contractIdSchema.describe(
            "Contract ID this package provides.",
          ),
          default: z
            .boolean()
            .describe(
              "`true` marks the default provider. It steps aside when another provider of the contract is selected.",
            )
            .optional(),
        }),
      ]),
    )
    .describe(
      "Versioned contracts this package provides, such as `narrative-engine@1`.",
    )
    .optional(),
  requires: z
    .array(contractIdSchema)
    .describe(
      "Contracts that must have an active provider. The resolver adds one when the package is active.",
    )
    .optional(),
  optional: z
    .array(contractIdSchema)
    .describe(
      "Contracts this package uses when a provider is active. They do not activate a provider.",
    )
    .optional(),
  conflicts: z
    .array(
      contractIdSchema.superRefine((contract, ctx) => {
        if (isKernelExtensionContract(contract))
          ctx.addIssue({
            code: "custom",
            message: kernelConflictMessage(contract),
            params: { code: INVALID_KERNEL_CONFLICT },
          });
      }),
    )
    .describe(
      "Contracts whose other providers cannot be active together with this package. Plugin contracts only.",
    )
    .optional(),
  contracts: z
    .record(
      contractIdSchema,
      z.strictObject({
        schema: z
          .string()
          .min(1)
          .describe("Package-relative path of the contract's JSON Schema."),
      }),
    )
    .describe(
      "Public schema of each contract this package publishes or accepts, keyed by contract ID.",
    )
    .optional(),
  entry: shape.entry,
  contributes: z
    .strictObject({
      tools: z
        .array(z.string().min(1))
        .describe("Names of tools the entry registers with `registerTool`.")
        .optional(),
      actions: z
        .array(z.string().min(1))
        .describe(
          "Names of RPC actions the entry registers with `registerRpc`.",
        )
        .optional(),
      commands: shape.commands,
      services: z
        .array(contractIdSchema)
        .describe(
          "Contract IDs of services the entry registers with `registerService`.",
        )
        .optional(),
      extensions: z
        .array(extensionDeclarationSchema)
        .describe("Extensions the entry provides with `provideExtension`.")
        .optional(),
      hooks: z
        .array(hookDeclarationSchema.pick({ event: true, enforce: true }))
        .describe("Lifecycle hooks the entry registers.")
        .optional(),
      wires: z
        .array(z.string().min(1))
        .describe("IDs of provider wires the entry registers.")
        .optional(),
      forms: z
        .array(z.string().min(1))
        .describe("IDs of forms the entry registers.")
        .optional(),
      events: shape.events,
      settings: shape.userSettings,
      data: z
        .record(
          z.string(),
          pluginDataSchemaDeclSchema
            .omit({
              namespace: true,
              schemaVersion: true,
              acceptsWorldData: true,
            })
            .extend({
              version: z
                .number()
                .int()
                .positive()
                .describe("Schema version of the namespace."),
              accepts: z
                .array(contractIdSchema)
                .describe(
                  "Data contracts whose world data this namespace accepts.",
                )
                .optional(),
              authoring: dataAuthoringSchema.optional(),
            })
            .refine(
              (declaration) =>
                !declaration.authoring || declaration.accepts?.length,
              {
                path: ["authoring"],
                message:
                  "authoring describes world data, so the namespace must list the contract in `accepts`",
              },
            ),
        )
        .describe("Own plugin data namespaces, keyed by namespace.")
        .optional(),
      ui: shape.ui,
      worldProjections: worldProjectionMapSchema
        .describe(
          "Pure projections from world data into own namespaces, keyed by projection ID.",
        )
        .optional(),
      prompt: z
        .array(
          z.strictObject({
            id: z
              .string()
              .min(1)
              .describe("ID of the segment within the package."),
            content: z.string().describe("Text of the segment."),
            position: z
              .union([
                z.enum(["system", "pre-history", "post-history"]),
                z.strictObject({
                  depth: z
                    .number()
                    .int()
                    .min(0)
                    .describe(
                      "Message depth at which the segment is inserted.",
                    ),
                }),
              ])
              .describe(
                "Where the segment goes: `system`, `pre-history`, `post-history`, or `{ depth }` for a position relative to the message history.",
              ),
            role: z
              .enum(["system", "user", "assistant"])
              .describe("Message role of the segment. Defaults to `system`.")
              .optional(),
          }),
        )
        .describe("Static prompt segments. The host registers them.")
        .optional(),
    })
    .describe(
      "Package-level contributions. Every entry registration needs a declaration here, and every declaration needs an implementation.",
    )
    .optional(),
  runtime: runtimeAuthoringManifestSchema
    .describe(
      "The single inline runtime of this package; its prompt is the body of this file. Packages with several runtimes use `runtimes/<id>/RUNTIME.md` instead.",
    )
    .optional(),
});
