/**
 * Zod schemas for validating world.yaml manifests.
 *
 * Mirrors the TypeScript types in types/world.ts.
 * Used by world-seed-loader and plugins with `world-data-provider` capability for validation.
 */

import { z } from "zod";

// ── Common ──────────────────────────────────────────────────────

/** I18nText: plain string or locale-keyed record. */
export const i18nTextSchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);

// ── Geography ───────────────────────────────────────────────────

export const worldLandmarkSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema.optional(),
  })
  .strict();

export const worldRegionSchema = z
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

export const factionTypeSchema = z.enum([
  "political",
  "guild",
  "corporate",
  "religious",
  "criminal",
  "military",
  "other",
]);

export const influenceLevelSchema = z.enum(["major", "minor"]);

export const factionRelationSchema = z
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

export const powerSystemTypeSchema = z.enum([
  "magic",
  "technology",
  "cultivation",
  "psychic",
  "hybrid",
  "other",
]);

export const powerTierSchema = z
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

export const historySignificanceSchema = z.enum(["major", "minor"]);

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

export const worldCurrencySchema = z
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

export const socialClassSchema = z
  .object({
    name: i18nTextSchema,
    description: i18nTextSchema,
    rank: z.number().int().optional(),
  })
  .strict();

export const worldRaceSchema = z
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

export const contentRatingSchema = z.enum(["all-ages", "teen", "mature"]);

export const worldToneSchema = z
  .object({
    genres: z.array(i18nTextSchema).min(1),
    contentRating: contentRatingSchema,
    narrativeStyle: i18nTextSchema.optional(),
    themes: z.array(i18nTextSchema).optional(),
  })
  .strict();

// ── Mechanics ───────────────────────────────────────────────────

export const combatStyleSchema = z.enum([
  "turn-based",
  "real-time",
  "narrative",
  "none",
]);
export const difficultyLevelSchema = z.enum([
  "easy",
  "normal",
  "hard",
  "adaptive",
]);

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

// ── Dimensions ──────────────────────────────────────────────────

export const worldDimensionsSchema = z
  .object({
    geography: worldGeographySchema.optional(),
    factions: z.array(worldFactionSchema).optional(),
    powerSystem: worldPowerSystemSchema.optional(),
    history: z.array(worldHistoryEventSchema).optional(),
    economy: worldEconomySchema.optional(),
    socialStructure: worldSocialStructureSchema.optional(),
    tone: worldToneSchema.optional(),
    mechanics: worldMechanicsSchema.optional(),
    startingConditions: worldStartingConditionsSchema.optional(),
  })
  .strict();

// ── Dimension Key → Sub-Schema Map ─────────────────────────────

/** Maps each dimension key to its Zod sub-schema for per-file validation. */
export const DIMENSION_KEY_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  geography: worldGeographySchema,
  factions: z.array(worldFactionSchema),
  powerSystem: worldPowerSystemSchema,
  history: z.array(worldHistoryEventSchema),
  economy: worldEconomySchema,
  socialStructure: worldSocialStructureSchema,
  tone: worldToneSchema,
  mechanics: worldMechanicsSchema,
  startingConditions: worldStartingConditionsSchema,
};

/** Valid dimension key names. */
export const DIMENSION_KEYS = Object.keys(
  DIMENSION_KEY_SCHEMAS,
) as readonly string[];

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
    plugins: z.array(z.string().min(1)).optional(),
    optionalPlugins: z.array(z.string().min(1)).optional(),
    excludedPlugins: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    reason: i18nTextSchema.optional(),
  })
  .strict();

const pluginPolicySchema = z
  .object({
    preset: z.string().min(1).optional(),
    packs: z.array(pluginPackSchema).optional(),
    preferTags: z.array(z.string().min(1)).optional(),
    avoidTags: z.array(z.string().min(1)).optional(),
    requireCapabilities: z.array(z.string().min(1)).optional(),
    requiredPlugins: z.array(z.string().min(1)).optional(),
    recommendedPlugins: z.array(z.string().min(1)).optional(),
    excludedPlugins: z.array(z.string().min(1)).optional(),
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
    defaultLocale: z.string().min(2),
    supportedLocales: z.array(z.string()).min(1).optional(),
    tags: z.array(z.string()).optional(),
    requiredPlugins: z.array(z.string()).optional(),
    recommendedPlugins: z.array(z.string()).optional(),
    excludedPlugins: z.array(z.string()).optional(),
    pluginPolicy: pluginPolicySchema.optional(),
    worldData: z.string().min(1).optional(),
    characterBlueprintSources: z.array(z.string().min(1)).optional(),
    dimensions: worldDimensionsSchema.optional(),
    /** Map of dimension key → relative file path for external dimension files. */
    dimensionSources: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

export type WorldManifestInput = z.input<typeof worldManifestSchema>;
