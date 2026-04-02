import type { I18nText } from "./common.js";

// ── Geography ──────────────────────────────────────────────

export interface WorldLandmark {
  name: I18nText;
  description?: I18nText;
}

export interface WorldRegion {
  name: I18nText;
  description: I18nText;
  climate?: string;
  landmarks?: WorldLandmark[];
}

export interface WorldGeography {
  overview?: I18nText;
  regions: WorldRegion[];
}

// ── Factions ───────────────────────────────────────────────

export type FactionType =
  | "political"
  | "guild"
  | "corporate"
  | "religious"
  | "criminal"
  | "military"
  | "other";

export type InfluenceLevel = "major" | "minor";

export interface FactionRelation {
  targetId: string;
  type: "allied" | "neutral" | "hostile" | "vassal";
  description?: I18nText;
}

export interface WorldFaction {
  id: string;
  name: I18nText;
  description: I18nText;
  type: FactionType;
  influence: InfluenceLevel;
  leader?: I18nText;
  headquarters?: string;
  relations?: FactionRelation[];
}

// ── Power System ───────────────────────────────────────────

export type PowerSystemType =
  | "magic"
  | "technology"
  | "cultivation"
  | "psychic"
  | "hybrid"
  | "other";

export interface PowerTier {
  name: I18nText;
  rank: number;
  description?: I18nText;
}

export interface WorldPowerSystem {
  name: I18nText;
  type: PowerSystemType;
  description: I18nText;
  rules: I18nText[];
  tiers?: PowerTier[];
}

// ── History ────────────────────────────────────────────────

export type HistorySignificance = "major" | "minor";

export interface WorldHistoryEvent {
  era?: string;
  year?: string;
  name: I18nText;
  description: I18nText;
  significance: HistorySignificance;
}

// ── Economy ────────────────────────────────────────────────

export interface WorldCurrency {
  name: I18nText;
  symbol?: string;
  description?: I18nText;
}

export interface WorldEconomy {
  currencies: WorldCurrency[];
  resources?: I18nText[];
  tradeNotes?: I18nText;
}

// ── Social Structure ───────────────────────────────────────

export interface SocialClass {
  name: I18nText;
  description?: I18nText;
  rank?: number;
}

export interface WorldRace {
  name: I18nText;
  description?: I18nText;
  traits?: I18nText[];
}

export interface WorldSocialStructure {
  classes?: SocialClass[];
  races?: WorldRace[];
  notes?: I18nText;
}

// ── Tone & Genre ───────────────────────────────────────────

export type ContentRating = "all-ages" | "teen" | "mature";

export interface WorldTone {
  genres: string[];
  contentRating: ContentRating;
  narrativeStyle?: I18nText;
  themes?: string[];
}

// ── Game Mechanics ─────────────────────────────────────────

export type CombatStyle = "turn-based" | "real-time" | "narrative" | "none";
export type DifficultyLevel = "easy" | "normal" | "hard" | "adaptive";

export interface WorldMechanics {
  combatStyle?: CombatStyle;
  skillSystem?: I18nText;
  difficulty?: DifficultyLevel;
  customRules?: I18nText[];
}

// ── Starting Conditions ────────────────────────────────────

export interface WorldStartingConditions {
  openingScenario: I18nText;
  playerConstraints?: I18nText[];
  startingLocation?: string;
  startingResources?: Record<string, number>;
}

// ── Composite ──────────────────────────────────────────────

/** All structured dimensions of a world. Every field is optional. */
export interface WorldDimensions {
  geography?: WorldGeography;
  factions?: WorldFaction[];
  powerSystem?: WorldPowerSystem;
  history?: WorldHistoryEvent[];
  economy?: WorldEconomy;
  socialStructure?: WorldSocialStructure;
  tone?: WorldTone;
  mechanics?: WorldMechanics;
  startingConditions?: WorldStartingConditions;
}
