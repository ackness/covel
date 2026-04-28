/**
 * World dimension types for world building and editing.
 */

// ── Common ───────────────────────────────────────────────────────

/** Multilingual text: plain string or locale-keyed record. */
export type I18nText = string | Record<string, string>;

// ── Wire-format World ────────────────────────────────────────────

/**
 * Wire-format `World` — the contract between server and API clients.
 *
 * This is the shape `/api/worlds` returns. The server's internal
 * `WorldRecord` (in `@covel/store`) is a superset that includes
 * backend-specific metadata fields not exposed over the network.
 */
export interface World {
  readonly id: string;
  readonly name: I18nText;
  readonly description: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

// ── Geography ────────────────────────────────────────────────────

export interface WorldLandmark {
  readonly name: I18nText;
  readonly description?: I18nText;
}

export interface WorldRegion {
  readonly name: I18nText;
  readonly description: I18nText;
  readonly climate: I18nText;
  readonly landmarks?: readonly WorldLandmark[];
}

export interface WorldGeography {
  readonly overview?: I18nText;
  readonly regions: readonly WorldRegion[];
}

// ── Factions ─────────────────────────────────────────────────────

export type FactionType =
  | 'political'
  | 'guild'
  | 'corporate'
  | 'religious'
  | 'criminal'
  | 'military'
  | 'other';

export type InfluenceLevel = 'major' | 'minor';

export interface FactionRelation {
  readonly type: string;
  readonly targetId: string;
  readonly description?: I18nText;
}

export interface WorldFaction {
  readonly id: string;
  readonly name: I18nText;
  readonly description: I18nText;
  readonly type: FactionType;
  readonly influence: InfluenceLevel;
  readonly leader?: I18nText;
  readonly headquarters?: I18nText;
  readonly relations?: readonly FactionRelation[];
}

// ── Power System ─────────────────────────────────────────────────

export type PowerSystemType =
  | 'magic'
  | 'technology'
  | 'cultivation'
  | 'psychic'
  | 'hybrid'
  | 'other';

export interface PowerTier {
  readonly name: I18nText;
  readonly rank: number;
}

export interface WorldPowerSystem {
  readonly name: I18nText;
  readonly type: PowerSystemType;
  readonly description: I18nText;
  readonly rules: readonly string[];
  readonly tiers?: readonly PowerTier[];
}

// ── History ──────────────────────────────────────────────────────

export type HistorySignificance = 'major' | 'minor';

export interface WorldHistoryEvent {
  readonly name: I18nText;
  readonly description: I18nText;
  readonly significance: HistorySignificance;
  readonly era?: I18nText;
  readonly year?: I18nText;
}

// ── Economy ──────────────────────────────────────────────────────

export interface WorldCurrency {
  readonly name: I18nText;
  readonly symbol?: string;
  readonly description?: I18nText;
}

export interface WorldEconomy {
  readonly currencies: readonly WorldCurrency[];
  readonly resources?: readonly (I18nText)[];
  readonly tradeNotes?: I18nText;
}

// ── Social Structure ─────────────────────────────────────────────

export interface SocialClass {
  readonly name: I18nText;
  readonly description: I18nText;
  readonly rank?: number;
}

export interface WorldRace {
  readonly name: I18nText;
  readonly description: I18nText;
  readonly traits?: readonly I18nText[];
}

export interface WorldSocialStructure {
  readonly classes?: readonly SocialClass[];
  readonly races?: readonly WorldRace[];
  readonly notes?: I18nText;
}

// ── Tone ─────────────────────────────────────────────────────────

export type ContentRating = 'all-ages' | 'teen' | 'mature';

export interface WorldTone {
  readonly genres: readonly string[];
  readonly contentRating: ContentRating;
  readonly narrativeStyle?: string;
  readonly themes?: readonly string[];
}

// ── Mechanics ────────────────────────────────────────────────────

export type CombatStyle = 'turn-based' | 'real-time' | 'narrative' | 'none';

export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'adaptive';

export interface WorldMechanics {
  readonly combatStyle?: CombatStyle;
  readonly difficulty?: DifficultyLevel;
  readonly skillSystem?: I18nText;
  readonly customRules?: readonly string[];
}

// ── Starting Conditions ──────────────────────────────────────────

export interface WorldStartingConditions {
  readonly openingScenario: I18nText;
  readonly startingLocation?: I18nText;
  readonly playerConstraints?: readonly string[];
  readonly startingResources?: Readonly<Record<string, number>>;
  /**
   * Optional editorial hook used by the session-canvas opening view —
   * one short headline that captures the choice the player is about to make
   * (e.g. "渡口起雾，选择下一步。"). Falls back to `openingScenario` when
   * absent.
   */
  readonly openingHook?: I18nText;
  /**
   * Short tags rendered as chips next to the opening hook. Two to four
   * tokens work best (e.g. ["青萍外门", "试炼前夜", "野生灵脉"]).
   */
  readonly openingChips?: readonly I18nText[];
}

// ── Aggregate ────────────────────────────────────────────────────

export interface WorldDimensions {
  readonly geography?: WorldGeography;
  readonly factions?: WorldFaction[];
  readonly powerSystem?: WorldPowerSystem;
  readonly history?: WorldHistoryEvent[];
  readonly economy?: WorldEconomy;
  readonly socialStructure?: WorldSocialStructure;
  readonly tone?: WorldTone;
  readonly mechanics?: WorldMechanics;
  readonly startingConditions?: WorldStartingConditions;
}
