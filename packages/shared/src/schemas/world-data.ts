import {
  parseWorldDataTarget,
  parseWorldDataIndexTarget,
} from "../world-data-target.js";
import { z } from "zod";

export const worldDataSourceIdRegex = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

export const worldDataSourceIdSchema = z
  .string()
  .regex(worldDataSourceIdRegex, {
    message:
      "source id must start with a letter and contain only letters, numbers, _ or -",
  });

export const worldDataSourceKindSchema = z.enum([
  "yaml",
  "json",
  "markdown",
  "text",
  "media",
]);

export const worldDataMergeModeSchema = z.enum(["replace", "skipExisting"]);

export const worldDataEffectSchema = z.enum(["characters", "projections"]);

/**
 * `hidden` sources import into the receiving plugin's reserved hidden bucket
 * and never reach prompts, public APIs, or the lorebook. Defaults to public.
 */
export const worldDataVisibilitySchema = z.enum(["public", "hidden"]);

const afterSchema = z.union([
  worldDataSourceIdSchema,
  z.array(worldDataSourceIdSchema).min(1),
]);

const worldDataSourceDescriptorBaseSchema = z
  .object({
    kind: worldDataSourceKindSchema.describe(
      "Reader type. `media` reads a directory of media files.",
    ),
    path: z
      .string()
      .min(1)
      .meta({
        description:
          "File or directory, relative to the world root. A variant `<name>.<locale>.<ext>` is used when it exists for the session locale.",
        examples: ["characters/main-cast.json"],
      }),
    schema: z
      .string()
      .min(1)
      .meta({
        description:
          "Schema that validates the content: `covel://world/dimensions`, `contract:<contractId>`, or a local JSON Schema path. Omit it for a `contract:` or dimensions destination: the schema is the one of the destination.",
        examples: ["contract:character.blueprints@1"],
      })
      .optional(),
    to: z
      .string()
      .min(1)
      .meta({
        description:
          "Destination: `world:metadata.<path>`, `contract:<contractId>`, `contract:<contractId>+lorebook`, `lorebook`, `characters` or `media`.",
        examples: ["contract:character.blueprints@1", "characters"],
      }),
    key: z
      .string()
      .min(1)
      .meta({
        description:
          "Field that gives each record a stable key. Media sources use `filename`.",
        examples: ["id"],
      })
      .optional(),
    localeArrayKeys: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Additional stable identity fields for nested object lists in locale overlays, after the source key and id. Translations retain these keys when lists are reordered.",
      )
      .optional(),
    indexTo: z
      .string()
      .min(1)
      .describe(
        "Media sources only: the `contract:<contractId>` that receives the media index. Without an active receiver the media bytes are not imported.",
      )
      .optional(),
    effects: z
      .array(worldDataEffectSchema)
      .describe(
        "Extra projections. `characters` instantiates characters; `projections` runs the pure projections that active plugins declare.",
      )
      .optional(),
    enabled: z.boolean().describe("`false` skips this source.").optional(),
    locale: z
      .string()
      .min(2)
      .describe(
        "Language of the content in this source. Metadata only; it does not select a locale variant.",
      )
      .optional(),
    merge: worldDataMergeModeSchema
      .describe("Policy when a record already exists.")
      .optional(),
    after: afterSchema
      .describe("Source ID or IDs that must import first.")
      .optional(),
    visibility: worldDataVisibilitySchema
      .describe(
        "`hidden` imports into the receiving plugin's hidden namespace. The data stays out of prompts and player-visible surfaces until the plugin reveals it. Requires a `contract:` destination. Defaults to `public`.",
      )
      .optional(),
  })
  .strict();

export const worldDataSourceDescriptorSchema =
  worldDataSourceDescriptorBaseSchema.superRefine((source, ctx) => {
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [field], message });
    if (!parseWorldDataTarget(source.to))
      issue(
        "to",
        "Use a supported destination; contract targets start with contract:",
      );
    if (source.kind === "media") {
      if (source.to !== "media")
        issue(
          "to",
          "A media reader must target media; set indexTo to its receiving contract",
        );
      if (!source.indexTo || !parseWorldDataIndexTarget(source.indexTo))
        issue("indexTo", "Media requires a contract:<id> index destination");
    } else {
      if (source.to === "media")
        issue(
          "kind",
          "The media destination requires a media directory reader",
        );
      if (source.indexTo !== undefined)
        issue("indexTo", "Only media readers produce a media index");
    }
  });

export const worldDataDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1).describe("Descriptor format version."),
    sources: z
      .record(worldDataSourceIdSchema, worldDataSourceDescriptorSchema)
      .describe(
        "Data sources keyed by source ID. A source ID starts with a letter and uses letters, digits, `_` or `-`.",
      ),
  })
  .strict();

export const worldDataSourceDescriptorOverrideSchema =
  worldDataSourceDescriptorBaseSchema.partial().strict();

export const worldDataDescriptorOverrideSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.record(
      worldDataSourceIdSchema,
      worldDataSourceDescriptorOverrideSchema,
    ),
  })
  .strict();

export const worldDataDiagnosticCountsSchema = z
  .object({
    info: z.number().int().min(0),
    warning: z.number().int().min(0),
    error: z.number().int().min(0),
  })
  .strict();

export const worldDataSourceSummarySchema = z
  .object({
    id: worldDataSourceIdSchema,
    digest: z.string().min(1),
    target: z.string().min(1),
    schema: z.string().min(1).optional(),
    importedAt: z.string().min(1).optional(),
    order: z.number().int().min(0),
    origin: z.enum(["world", "override"]),
    overridden: z.boolean().optional(),
    diagnostics: worldDataDiagnosticCountsSchema,
  })
  .strict();

export const worldDataMetadataSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(worldDataSourceSummarySchema),
  })
  .strict();

export type WorldDataDescriptorInput = z.input<
  typeof worldDataDescriptorSchema
>;

export type WorldDataDescriptorOverrideInput = z.input<
  typeof worldDataDescriptorOverrideSchema
>;
