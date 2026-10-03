/**
 * Zod schemas for validating world.yaml manifests.
 *
 * Mirrors the TypeScript types in types/world.ts.
 * Used by world-seed-loader and plugins with `world-data-provider` capability for validation.
 */

import { z } from "zod";
import { canonicalizeLocale } from "../utils/locale-registry.js";
import type { AttributeDefinition } from "../types/character-schema.js";
import { dimensionIdSchema, worldDimensionsSchema } from "./dimensions.js";
export { worldDimensionsSchema } from "./dimensions.js";

// ── Common ──────────────────────────────────────────────────────

/** I18nText: plain string or locale-keyed record. */
export const i18nTextSchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);

const localeCodeSchema = z
  .string()
  .refine((value) => canonicalizeLocale(value) !== undefined, {
    message: "must be a safe canonicalizable locale code",
  })
  .transform((value) => canonicalizeLocale(value)!);

// ── Geography ───────────────────────────────────────────────────

const worldLandmarkSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema.optional(),
  })
  .strict();

const worldRegionSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema,
    climate: i18nTextSchema,
    landmarks: z.array(worldLandmarkSchema).optional(),
  })
  .strict();

export const worldGeographySchema = z
  .object({
    overview: i18nTextSchema.optional(),
    regions: z.array(worldRegionSchema).min(1),
  })
  .strict();

// ── Factions ────────────────────────────────────────────────────

const factionTypeSchema = z.enum([
  "political",
  "guild",
  "corporate",
  "religious",
  "criminal",
  "military",
  "other",
]);

const influenceLevelSchema = z.enum(["major", "minor"]);

const factionRelationSchema = z
  .object({
    type: z.string().min(1),
    targetId: z.string().min(1),
    description: i18nTextSchema.optional(),
  })
  .strict();

export const worldFactionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message:
          'faction id must be lowercase with hyphens (e.g. "dark-guild")',
      }),
    name: i18nTextSchema,
    description: i18nTextSchema,
    type: factionTypeSchema,
    influence: influenceLevelSchema,
    leader: i18nTextSchema.optional(),
    headquarters: i18nTextSchema.optional(),
    relations: z.array(factionRelationSchema).optional(),
  })
  .strict();

// ── Power System ────────────────────────────────────────────────

const powerSystemTypeSchema = z.enum([
  "magic",
  "technology",
  "cultivation",
  "psychic",
  "hybrid",
  "other",
]);

const powerTierSchema = z
  .object({
    name: i18nTextSchema,
    rank: z.number().int().min(1),
    description: i18nTextSchema.optional(),
  })
  .strict();

export const worldPowerSystemSchema = z
  .object({
    name: i18nTextSchema,
    type: powerSystemTypeSchema,
    description: i18nTextSchema,
    rules: z.array(i18nTextSchema).min(1),
    tiers: z.array(powerTierSchema).optional(),
  })
  .strict();

// ── History ─────────────────────────────────────────────────────

const historySignificanceSchema = z.enum(["major", "minor"]);

export const worldHistoryEventSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema,
    significance: historySignificanceSchema,
    era: i18nTextSchema.optional(),
    year: i18nTextSchema.optional(),
  })
  .strict();

// ── Economy ─────────────────────────────────────────────────────

const worldCurrencySchema = z
  .object({
    name: i18nTextSchema,
    symbol: z.string().optional(),
    description: i18nTextSchema.optional(),
  })
  .strict();

export const worldEconomySchema = z
  .object({
    currencies: z.array(worldCurrencySchema).min(1),
    resources: z.array(i18nTextSchema).optional(),
    tradeNotes: i18nTextSchema.optional(),
  })
  .strict();

// ── Social Structure ────────────────────────────────────────────

const socialClassSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema,
    rank: z.number().int().optional(),
  })
  .strict();

const worldRaceSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema,
    traits: z.array(i18nTextSchema).optional(),
  })
  .strict();

export const worldSocialStructureSchema = z
  .object({
    classes: z.array(socialClassSchema).optional(),
    races: z.array(worldRaceSchema).optional(),
    notes: i18nTextSchema.optional(),
  })
  .strict();

// ── Tone ────────────────────────────────────────────────────────

const contentRatingSchema = z.enum(["all-ages", "teen", "mature"]);

export const worldToneSchema = z
  .object({
    genres: z.array(i18nTextSchema).min(1),
    contentRating: contentRatingSchema,
    narrativeStyle: i18nTextSchema.optional(),
    themes: z.array(i18nTextSchema).optional(),
  })
  .strict();

// ── Mechanics ───────────────────────────────────────────────────

const combatStyleSchema = z.enum([
  "turn-based",
  "real-time",
  "narrative",
  "none",
]);
const difficultyLevelSchema = z.enum(["easy", "normal", "hard", "adaptive"]);

export const worldMechanicsSchema = z
  .object({
    combatStyle: combatStyleSchema.optional(),
    difficulty: difficultyLevelSchema.optional(),
    skillSystem: i18nTextSchema.optional(),
    customRules: z.array(i18nTextSchema).optional(),
  })
  .strict();

// ── Starting Conditions ─────────────────────────────────────────

export const worldStartingConditionsSchema = z
  .object({
    openingScenario: i18nTextSchema,
    startingLocation: i18nTextSchema.optional(),
    playerConstraints: z.array(i18nTextSchema).optional(),
    startingResources: z.record(z.string(), z.number()).optional(),
    openingHook: i18nTextSchema.optional(),
    openingChips: z.array(i18nTextSchema).optional(),
  })
  .strict();

// ── World Manifest (world.yaml root) ────────────────────────────

const pluginPackSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message:
          'plugin pack id must be lowercase with hyphens (e.g. "dialogue-mode")',
      })
      .describe(
        "Stable pack ID: lowercase letters, digits and hyphens. `presetId` refers to it.",
      ),
    label: i18nTextSchema.describe("Display name of the pack."),
    description: i18nTextSchema
      .describe("What the pack offers. Shown to the player.")
      .optional(),
    requested: z
      .array(z.string().min(1))
      .describe("Plugin IDs the pack enables.")
      .optional(),
    recommended: z
      .array(z.string().min(1))
      .describe(
        "Plugin IDs the pack suggests. They are not enabled automatically.",
      )
      .optional(),
    tags: z
      .array(z.string().min(1))
      .describe(
        "Catalogue tags that describe the pack, such as `mode:traditional-story`.",
      )
      .optional(),
    reason: i18nTextSchema
      .describe("Why this pack suits the world. Shown to the player.")
      .optional(),
  })
  .strict();

const pluginPolicySchema = z
  .object({
    presetId: z
      .string()
      .min(1)
      .describe(
        "ID of the pack that seeds the initial plugin selection: a built-in pack or one declared in `packs`.",
      )
      .optional(),
    packs: z
      .array(pluginPackSchema)
      .describe(
        "Packs defined by this world. A pack is a named plugin selection the player can choose before play.",
      )
      .optional(),
    preferredTags: z
      .array(z.string().min(1))
      .describe(
        "Plugin tags this world prefers, such as `mode:traditional-story`.",
      )
      .optional(),
    avoidedTags: z
      .array(z.string().min(1))
      .describe("Plugin tags this world avoids, such as `mode:dialogue`.")
      .optional(),
    requested: z
      .array(z.string().min(1))
      .describe(
        "Plugin IDs to enable by default. The player can still exclude them.",
      )
      .optional(),
    recommended: z
      .array(z.string().min(1))
      .describe("Plugin IDs to suggest. They are not enabled automatically.")
      .optional(),
    // Contract IDs, not plugin IDs: any installed provider satisfies them.
    requires: z
      .array(
        z.string().regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/, {
          message:
            'a required contract must look like "action-check@1" (a contract ID, not a plugin ID)',
        }),
      )
      .describe(
        "Contract IDs the world needs, such as `action-check@1`. Any installed provider satisfies one. A missing or ambiguous provider blocks session creation.",
      )
      .optional(),
  })
  .strict();

// ── Character attribute schema (world-declared) ─────────────────
//
// A world may ship its own `CharacterAttributeSchema` so the right panel and
// context injection use authored, i18n labels (e.g. "社团" / "Club") instead
// of the generic attributes `deriveSchema()` infers from dimensions. When
// present, `world-init`'s guard writes this verbatim and skips the LLM
// schema-gen entirely. Mirrors `AttributeDefinition` in
// types/character-schema.ts; `name` / `description` accept i18n records.
const attributeFieldTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
  "map",
]);

const attributeCategorySchema = z.enum([
  "stats",
  "bio",
  "abilities",
  "equipment",
  "social",
]);

/** @type {z.ZodType} */
export const attributeDefinitionSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      id: z
        .string()
        .min(1)
        .describe("Stable machine key of the attribute, such as `hp`."),
      name: i18nTextSchema.describe("Display label of the attribute."),
      type: attributeFieldTypeSchema.describe(
        "Value type. `object` needs `subSchema`; `map` is an open-key record typed by `valueType`.",
      ),
      min: z.number().describe("Minimum value. For `number` only.").optional(),
      max: z.number().describe("Maximum value. For `number` only.").optional(),
      defaultValue: z
        .unknown()
        .describe("Value given to a new character.")
        .optional(),
      itemType: z
        .enum(["string", "number"])
        .describe("Element type. For `array` only.")
        .optional(),
      options: z
        .array(z.string())
        .describe("Allowed values. For `enum` only.")
        .optional(),
      subSchema: z
        .array(attributeDefinitionSchema)
        .describe("Child attribute definitions. For `object` only.")
        .optional(),
      valueType: z
        .enum(["string", "number", "boolean"])
        .describe(
          "Value type of each entry. For `map` only; defaults to string.",
        )
        .optional(),
      category: attributeCategorySchema.describe(
        "Group used by the character panel and by prompt context.",
      ),
      description: i18nTextSchema
        .describe(
          "What the attribute means. Shown to the player and given to the model.",
        )
        .optional(),
    })
    .strict(),
);

export const characterSchemaSchema = z
  .object({
    version: z
      .number()
      .int()
      .positive()
      .describe("Schema version. The kernel increments it; do not author it."),
    types: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((value) => value !== "player", "player is a reserved type"),
      )
      .refine(
        (values) => new Set(values).size === values.length,
        "character types must be unique",
      )
      .default(["npc", "companion"])
      .describe(
        "Character types besides the reserved `player`. Defaults to `npc` and `companion`.",
      ),
    attributes: z
      .array(
        z.lazy(
          () => attributeDefinitionSchema as z.ZodType<AttributeDefinition>,
        ),
      )
      .describe("Attribute definitions. Display order follows array order."),
  })
  .strict();

export const worldManifestSchema = z
  .object({
    schemaVersion: z
      .string()
      .min(1)
      .meta({
        description: "Version of the `world.yaml` format.",
        examples: ["1.0"],
      }),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message: 'id must be lowercase with hyphens (e.g. "my-world")',
      })
      .meta({
        description:
          "Stable world ID: lowercase letters, digits and hyphens, starting with a letter.",
        examples: ["my-world"],
      }),
    name: i18nTextSchema.describe("Display name of the world."),
    version: z
      .string()
      .meta({
        description: "Version of the world package.",
        examples: ["0.1.0"],
      })
      .optional(),
    summary: i18nTextSchema.describe(
      "One or two sentences shown on the world card.",
    ),
    defaultLocale: localeCodeSchema.meta({
      description:
        "Default content locale as a BCP 47 tag. A session uses it when the request sets no locale.",
      examples: ["zh-CN", "en-US"],
    }),
    supportedLocales: z
      .array(localeCodeSchema)
      .min(1)
      .describe("Locales this world provides content for.")
      .optional(),
    tags: z
      .array(z.string())
      .describe("Free-form catalogue tags, such as genre.")
      .optional(),
    pluginPolicy: pluginPolicySchema
      .describe(
        "Which plugins a session of this world starts with. It states intent and locks nothing; the player can change the selection.",
      )
      .optional(),
    worldData: z
      .string()
      .min(1)
      .meta({
        description:
          "Path of the world data descriptor, relative to the world root.",
        examples: ["data/world.data.yaml"],
      })
      .optional(),
    /**
     * World-declared character attribute definitions. When non-empty,
     * `world-init` writes this verbatim as the session's
     * `character schema` schema (no LLM, no dimension-derived fallback),
     * so the right panel renders authored i18n labels.
     */
    characterSchema: z
      .lazy(() => characterSchemaSchema.omit({ version: true }))
      .describe(
        "Character types and attributes of this world. When present, sessions use it as written and no schema is generated.",
      )
      .optional(),
    dimensions: worldDimensionsSchema
      .describe(
        "Dynamic world dimensions keyed by dimension ID. Each entry is one full definition.",
      )
      .optional(),
    /** Map of dimension key → relative file path for external dimension files. */
    dimensionSources: z
      .record(dimensionIdSchema, z.string().min(1))
      .describe(
        "Dimension ID → path of an external file that holds that one definition, relative to the world root.",
      )
      .optional(),
    /**
     * World-authored default values for plugins' declared `userSettings`,
     * keyed `pluginId → settingKey → value`. Middle layer of the resolution
     * chain (player override → world default → manifest default); players can
     * still override each value. Unknown keys are harmless — the runtime only
     * reads keys a plugin actually declares.
     */
    pluginSettings: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .describe(
        "World defaults for plugin settings, keyed `pluginId → settingKey → value`. Resolution order: player override, then this value, then the plugin's own default.",
      )
      .optional(),
    /**
     * Preferred `GameViewMode` for new sessions of this world ("stage" =
     * fullscreen visual-novel stage). Player's own choice still wins once made;
     * this only seeds the initial value. Unrecognised values fall back to
     * "parsed".
     */
    defaultViewMode: z
      .enum(["stage", "parsed"])
      .describe(
        "Initial view for new sessions. `stage` is the fullscreen visual-novel stage. The player's own choice wins once made.",
      )
      .optional(),
  })
  .strict();

export type WorldManifestInput = z.input<typeof worldManifestSchema>;
