import {
  isKernelExtensionContract,
  INVALID_KERNEL_CONFLICT,
  kernelConflictMessage,
} from "../extension-points/contracts.js";
import { z } from "zod";
import { FRAMEWORK_PLUGIN_ID } from "../framework-plugin-id.js";
import { hostVersionRangeSchema } from "../utils/host-version-range.js";
import { packageCreditFields } from "./package-info.js";
import { attributeFieldTypeSchema } from "./world.js";
import {
  RESERVED_WORLD_PACKAGE_PATHS,
  isReservedWorldPackagePath,
} from "../world-package-paths.js";
import {
  contractIdSchema,
  runtimeAuthoringManifestSchema,
} from "./runtime-manifest.js";
import {
  extensionDeclarationSchema,
  hookDeclarationSchema,
  permissionsDeclSchema,
  pluginCommandsSchema,
  pluginDataSchemaDeclSchema,
  pluginDescriptionSchema,
  pluginDisplayNameSchema,
  pluginEntryPathSchema,
  pluginEventsSchema,
  pluginUiPathsSchema,
  pluginUserSettingsSchema,
  worldProjectionMapSchema,
} from "./plugin-schemas.js";

/**
 * `attributes[].id`: field names, `[]` after one that holds a list. `**`
 * before a field name reaches that field at any depth below (`when.**.dimension`
 * finds it in a condition however deeply `all` / `any` / `not` nest).
 */
const DATA_REFERENCE_PATH =
  /^(?:\*\*\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.(?:\*\*\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/;

/**
 * What a world author needs in order to supply one kind of world data. It
 * lives with the plugin that accepts the data, so authoring tools, skills and
 * the world generator learn about a new plugin without a central edit.
 */
const dataAuthoringSchema = z
  .strictObject({
    title: z.union([z.string().min(1), z.record(z.string(), z.string())]).meta({
      description:
        "Author-facing name of this content. Plain string; translations go in locale files.",
      examples: ["Starting quests"],
    }),
    summary: z
      .union([z.string().min(1), z.record(z.string(), z.string())])
      .describe(
        "One player-facing sentence about this content. Shown where a player chooses what a generated world includes. Plain string; translations go in locale files.",
      )
      .optional(),
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
          .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+$/i, {
            message:
              "source path must be a world-package-relative path (no leading `/`, no `..` segments)",
          })
          .refine((path) => !isReservedWorldPackagePath(path), {
            message: `source path must not name a file the kernel or the world package owns (${RESERVED_WORLD_PACKAGE_PATHS.join(", ")})`,
          })
          .meta({
            description:
              "Conventional path of the source inside a world package. It may not name a path the kernel or the package itself owns: `world.yaml`, `WORLD.md`, `data/world.data.yaml`, `data/dimensions.yaml`, `data/lorebook.yaml`, `characters/characters.json`, `media/gallery.json`, `media/portraits.json`, `media/scenes.json` or `media/gallery/`, nor an edition of one.",
            examples: ["data/quests.yaml"],
          }),
        key: z
          .string()
          .min(1)
          .describe(
            "Field that gives each record a stable key. Media sources use `filename`.",
          )
          .optional(),
        localeArrayKeys: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Additional stable identity fields for nested object lists in locale overlays, after the source key and id. Translations retain these keys when lists are reordered.",
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
    references: z
      .array(
        z
          .strictObject({
            path: z
              .string()
              .regex(DATA_REFERENCE_PATH, {
                message:
                  "path must be field names joined by `.`, with `[]` after a field that holds a list (`attributes[].id`) and `**.` before a field found at any depth (`when.**.dimension`)",
              })
              .meta({
                description:
                  "Where the referring values are in each record: field names joined by `.`, with `[]` after a field that holds a list. `**.` before a field name finds that field at any depth below.",
                examples: ["attributes[].id", "when.**.dimension"],
              }),
            to: z
              .enum(["character-attribute", "world-dimension"])
              .describe(
                "What each value must name. `character-attribute` is the `id` of a top-level attribute of the world's `characterSchema`; `world-dimension` is the ID of a dimension the world declares.",
              ),
            type: attributeFieldTypeSchema
              .describe(
                "Value type the named attribute must have. Only with `to: character-attribute`.",
              )
              .optional(),
            within: z
              .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
              .min(1)
              .describe(
                "Fields beside the referring value that must lie inside what it names. For `character-attribute`, number fields inside the attribute's `min` and `max`; for `world-dimension`, a path into the dimension's value (`a.b`, or a list of keys) that its schema allows.",
              )
              .optional(),
            values: z
              .array(z.string().regex(DATA_REFERENCE_PATH))
              .min(1)
              .describe(
                "Sibling paths holding candidate values of a world dimension. Uses the same path syntax as `path`; `in[]` checks each list member, while `equals` checks the whole value. Checked against the schema at the single `within` path, or the root when absent. Only with `to: world-dimension`; at most one `within` field when set.",
              )
              .optional(),
          })
          .refine(
            (reference) =>
              reference.type === undefined ||
              reference.to === "character-attribute",
            {
              path: ["type"],
              message: "type is only for `to: character-attribute`",
            },
          )
          .refine(
            (reference) =>
              reference.values === undefined ||
              (reference.to === "world-dimension" &&
                (reference.within?.length ?? 0) <= 1),
            {
              path: ["values"],
              message:
                "values requires `to: world-dimension` and at most one `within` field",
            },
          ),
      )
      .min(1)
      .describe(
        "Values in each record that name something of the world. `pnpm validate:world` reports a value that names nothing, or the wrong kind of thing, before a session starts.",
      )
      .optional(),
    generate: z
      .enum(["offer", "default"])
      .describe(
        "Lets the in-app world generator produce this content from `hint` and `example` alone. `offer` lists it as a choice; `default` also selects it. It needs an `example`, and a public, non-media `source` keyed by `id`.",
      )
      .optional(),
  })
  .refine(
    (authoring) =>
      !authoring.generate ||
      (authoring.example !== undefined &&
        authoring.source !== undefined &&
        authoring.source.kind !== "media" &&
        (authoring.source.key ?? "id") === "id" &&
        authoring.source.visibility !== "hidden"),
    {
      path: ["generate"],
      message:
        "generate needs an example and a public, non-media source keyed by `id`",
    },
  )
  .describe(
    "What a world author needs to supply this content. Authoring tools and the world generator read it.",
  );
export const pluginManifestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .refine(
      (id) => id !== FRAMEWORK_PLUGIN_ID,
      `"${FRAMEWORK_PLUGIN_ID}" is reserved for the framework`,
    )
    .meta({
      description:
        "Stable package ID: lowercase letters, digits and hyphens. It must match the package directory name. `framework` is reserved.",
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
  // Host versions this package was written for; install and load enforce it.
  covel: hostVersionRangeSchema
    .meta({
      description:
        "Host version range this package supports. A host outside it does not install or load the package.",
      examples: [">=0.0.45"],
    })
    .optional(),
  displayName: pluginDisplayNameSchema.optional(),
  description: pluginDescriptionSchema,
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
  ...packageCreditFields,
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
      "Public schema of each contract this package publishes or accepts, keyed by contract ID. A contract that a `contributes.data` namespace accepts needs no entry here: its schema is the one of that namespace.",
    )
    .optional(),
  entry: pluginEntryPathSchema.optional(),
  permissions: permissionsDeclSchema
    .describe(
      "Upper bounds of the package's own code. `http` lists the origins and methods the entry module of a community package may reach through `covel.http`, in addition to those its runtimes declare.",
    )
    .optional(),
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
      commands: pluginCommandsSchema.optional(),
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
      events: pluginEventsSchema.optional(),
      settings: pluginUserSettingsSchema.optional(),
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
              search: z
                .strictObject({
                  text: z
                    .string()
                    .min(1)
                    .describe(
                      "Field of a record's value that holds the text to search. A record without a string there is not searched.",
                    ),
                })
                .describe(
                  "Makes the records of this namespace part of memory search (`memory-search`) while the plugin is active in the session.",
                )
                .optional(),
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
      ui: pluginUiPathsSchema
        .describe(
          "Package-relative paths of declarative UI specs, by placement.",
        )
        .optional(),
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
