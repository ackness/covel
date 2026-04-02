import { z } from "zod";

// ── Shared primitives ──────────────────────────────────────

const i18nTextSchema = z.union([
  z.string().min(1),
  z.record(z.string().min(1)),
]);

// ── Geography ──────────────────────────────────────────────

const landmarkSchema = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema.optional(),
});

const regionSchema = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema,
  climate: z.string().optional(),
  landmarks: z.array(landmarkSchema).optional(),
});

const geographySchema = z.object({
  overview: i18nTextSchema.optional(),
  regions: z.array(regionSchema).min(1),
});

// ── Factions ───────────────────────────────────────────────

const factionTypeSchema = z.enum([
  "political", "guild", "corporate", "religious", "criminal", "military", "other",
]);

const influenceLevelSchema = z.enum(["major", "minor"]);

const factionRelationSchema = z.object({
  targetId: z.string().min(1),
  type: z.enum(["allied", "neutral", "hostile", "vassal"]),
  description: i18nTextSchema.optional(),
});

const factionSchema = z.object({
  id: z.string().min(1),
  name: i18nTextSchema,
  description: i18nTextSchema,
  type: factionTypeSchema,
  influence: influenceLevelSchema,
  leader: i18nTextSchema.optional(),
  headquarters: z.string().optional(),
  relations: z.array(factionRelationSchema).optional(),
});

// ── Power System ───────────────────────────────────────────

const powerSystemTypeSchema = z.enum([
  "magic", "technology", "cultivation", "psychic", "hybrid", "other",
]);

const powerTierSchema = z.object({
  name: i18nTextSchema,
  rank: z.number().int().min(0),
  description: i18nTextSchema.optional(),
});

const powerSystemSchema = z.object({
  name: i18nTextSchema,
  type: powerSystemTypeSchema,
  description: i18nTextSchema,
  rules: z.array(i18nTextSchema).min(1),
  tiers: z.array(powerTierSchema).optional(),
});

// ── History ────────────────────────────────────────────────

const historyEventSchema = z.object({
  era: z.string().optional(),
  year: z.string().optional(),
  name: i18nTextSchema,
  description: i18nTextSchema,
  significance: z.enum(["major", "minor"]),
});

// ── Economy ────────────────────────────────────────────────

const currencySchema = z.object({
  name: i18nTextSchema,
  symbol: z.string().optional(),
  description: i18nTextSchema.optional(),
});

const economySchema = z.object({
  currencies: z.array(currencySchema).min(1),
  resources: z.array(i18nTextSchema).optional(),
  tradeNotes: i18nTextSchema.optional(),
});

// ── Social Structure ───────────────────────────────────────

const socialClassSchema = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema.optional(),
  rank: z.number().int().optional(),
});

const raceSchema = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema.optional(),
  traits: z.array(i18nTextSchema).optional(),
});

const socialStructureSchema = z.object({
  classes: z.array(socialClassSchema).optional(),
  races: z.array(raceSchema).optional(),
  notes: i18nTextSchema.optional(),
});

// ── Tone & Genre ───────────────────────────────────────────

const toneSchema = z.object({
  genres: z.array(z.string().min(1)).min(1),
  contentRating: z.enum(["all-ages", "teen", "mature"]),
  narrativeStyle: i18nTextSchema.optional(),
  themes: z.array(z.string().min(1)).optional(),
});

// ── Game Mechanics ─────────────────────────────────────────

const mechanicsSchema = z.object({
  combatStyle: z.enum(["turn-based", "real-time", "narrative", "none"]).optional(),
  skillSystem: i18nTextSchema.optional(),
  difficulty: z.enum(["easy", "normal", "hard", "adaptive"]).optional(),
  customRules: z.array(i18nTextSchema).optional(),
});

// ── Starting Conditions ────────────────────────────────────

const startingConditionsSchema = z.object({
  openingScenario: i18nTextSchema,
  playerConstraints: z.array(i18nTextSchema).optional(),
  startingLocation: z.string().optional(),
  startingResources: z.record(z.number()).optional(),
});

// ── Composite ──────────────────────────────────────────────

export const worldDimensionsSchema = z.object({
  geography: geographySchema.optional(),
  factions: z.array(factionSchema).optional(),
  powerSystem: powerSystemSchema.optional(),
  history: z.array(historyEventSchema).optional(),
  economy: economySchema.optional(),
  socialStructure: socialStructureSchema.optional(),
  tone: toneSchema.optional(),
  mechanics: mechanicsSchema.optional(),
  startingConditions: startingConditionsSchema.optional(),
});

// ── WorldRecord schemas (API boundary) ─────────────────────

export const worldRecordCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  lore: z.string().optional(),
  locale: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dimensions: worldDimensionsSchema.optional(),
});

export const worldRecordUpdateSchema = worldRecordCreateSchema.partial();

export type WorldRecordCreate = z.infer<typeof worldRecordCreateSchema>;
export type WorldRecordUpdate = z.infer<typeof worldRecordUpdateSchema>;
