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
      }),
    label: i18nTextSchema,
    description: i18nTextSchema.optional(),
    requested: z.array(z.string().min(1)).optional(),
    recommended: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    reason: i18nTextSchema.optional(),
  })
  .strict();

const pluginPolicySchema = z
  .object({
    presetId: z.string().min(1).optional(),
    packs: z.array(pluginPackSchema).optional(),
    preferredTags: z.array(z.string().min(1)).optional(),
    avoidedTags: z.array(z.string().min(1)).optional(),
    requested: z.array(z.string().min(1)).optional(),
    recommended: z.array(z.string().min(1)).optional(),
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
      id: z.string().min(1),
      name: i18nTextSchema,
      type: attributeFieldTypeSchema,
      min: z.number().optional(),
      max: z.number().optional(),
      defaultValue: z.unknown().optional(),
      itemType: z.enum(["string", "number"]).optional(),
      options: z.array(z.string()).optional(),
      subSchema: z.array(attributeDefinitionSchema).optional(),
      valueType: z.enum(["string", "number", "boolean"]).optional(),
      category: attributeCategorySchema,
      description: i18nTextSchema.optional(),
    })
    .strict(),
);

export const characterSchemaSchema = z
  .object({
    version: z.number().int().positive(),
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
      .default(["npc", "companion"]),
    attributes: z.array(
      z.lazy(() => attributeDefinitionSchema as z.ZodType<AttributeDefinition>),
    ),
  })
  .strict();

export const worldManifestSchema = z
  .object({
    schemaVersion: z.string().min(1),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message: 'id must be lowercase with hyphens (e.g. "my-world")',
      }),
    name: i18nTextSchema,
    version: z.string().optional(),
    summary: i18nTextSchema,
    defaultLocale: localeCodeSchema,
    supportedLocales: z.array(localeCodeSchema).min(1).optional(),
    tags: z.array(z.string()).optional(),
    pluginPolicy: pluginPolicySchema.optional(),
    worldData: z.string().min(1).optional(),
    /**
     * World-declared character attribute definitions. When non-empty,
     * `world-init` writes this verbatim as the session's
     * `character schema` schema (no LLM, no dimension-derived fallback),
     * so the right panel renders authored i18n labels.
     */
    characterSchema: z
      .lazy(() => characterSchemaSchema.omit({ version: true }))
      .optional(),
    dimensions: worldDimensionsSchema.optional(),
    /** Map of dimension key → relative file path for external dimension files. */
    dimensionSources: z.record(dimensionIdSchema, z.string().min(1)).optional(),
    /**
     * World-authored default values for plugins' declared `userSettings`,
     * keyed `pluginId → settingKey → value`. Middle layer of the resolution
     * chain (player override → world default → manifest default); players can
     * still override each value. Unknown keys are harmless — the runtime only
     * reads keys a plugin actually declares.
     */
    pluginSettings: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
    /**
     * Preferred `GameViewMode` for new sessions of this world ("stage" =
     * fullscreen visual-novel stage). Player's own choice still wins once made;
     * this only seeds the initial value. Unrecognised values fall back to
     * "parsed".
     */
    defaultViewMode: z.enum(["stage", "parsed"]).optional(),
  })
  .strict();

export type WorldManifestInput = z.input<typeof worldManifestSchema>;
