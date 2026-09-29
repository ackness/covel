/** Structural public mirror of the kernel's WorldDimensions contract. */
export type ExtensionWorldI18nText = string | Record<string, string>;

export interface ExtensionWorldLandmark {
  readonly name: ExtensionWorldI18nText;
  readonly description?: ExtensionWorldI18nText;
}

export interface ExtensionWorldRegion {
  readonly name: ExtensionWorldI18nText;
  readonly description: ExtensionWorldI18nText;
  readonly climate: ExtensionWorldI18nText;
  readonly landmarks?: readonly ExtensionWorldLandmark[];
}

export interface ExtensionWorldGeography {
  readonly overview?: ExtensionWorldI18nText;
  readonly regions: readonly ExtensionWorldRegion[];
}

export interface ExtensionWorldFaction {
  readonly id: string;
  readonly name: ExtensionWorldI18nText;
  readonly description: ExtensionWorldI18nText;
  readonly type:
    | "political"
    | "guild"
    | "corporate"
    | "religious"
    | "criminal"
    | "military"
    | "other";
  readonly influence: "major" | "minor";
  readonly leader?: ExtensionWorldI18nText;
  readonly headquarters?: ExtensionWorldI18nText;
  readonly relations?: readonly {
    readonly type: string;
    readonly targetId: string;
    readonly description?: ExtensionWorldI18nText;
  }[];
}

export interface ExtensionWorldPowerSystem {
  readonly name: ExtensionWorldI18nText;
  readonly type:
    "magic" | "technology" | "cultivation" | "psychic" | "hybrid" | "other";
  readonly description: ExtensionWorldI18nText;
  readonly rules: readonly string[];
  readonly tiers?: readonly {
    readonly name: ExtensionWorldI18nText;
    readonly rank: number;
  }[];
}

export interface ExtensionWorldHistoryEvent {
  readonly name: ExtensionWorldI18nText;
  readonly description: ExtensionWorldI18nText;
  readonly significance: "major" | "minor";
  readonly era?: ExtensionWorldI18nText;
  readonly year?: ExtensionWorldI18nText;
}

export interface ExtensionWorldEconomy {
  readonly currencies: readonly {
    readonly name: ExtensionWorldI18nText;
    readonly symbol?: string;
    readonly description?: ExtensionWorldI18nText;
  }[];
  readonly resources?: readonly ExtensionWorldI18nText[];
  readonly tradeNotes?: ExtensionWorldI18nText;
}

export interface ExtensionWorldSocialStructure {
  readonly classes?: readonly {
    readonly name: ExtensionWorldI18nText;
    readonly description: ExtensionWorldI18nText;
    readonly rank?: number;
  }[];
  readonly races?: readonly {
    readonly name: ExtensionWorldI18nText;
    readonly description: ExtensionWorldI18nText;
    readonly traits?: readonly ExtensionWorldI18nText[];
  }[];
  readonly notes?: ExtensionWorldI18nText;
}

export interface ExtensionWorldTone {
  readonly genres: readonly string[];
  readonly contentRating: "all-ages" | "teen" | "mature";
  readonly narrativeStyle?: string;
  readonly themes?: readonly string[];
}

export interface ExtensionWorldMechanics {
  readonly combatStyle?: "turn-based" | "real-time" | "narrative" | "none";
  readonly difficulty?: "easy" | "normal" | "hard" | "adaptive";
  readonly skillSystem?: ExtensionWorldI18nText;
  readonly customRules?: readonly string[];
}

export interface ExtensionWorldStartingConditions {
  readonly openingScenario: ExtensionWorldI18nText;
  readonly startingLocation?: ExtensionWorldI18nText;
  readonly playerConstraints?: readonly string[];
  readonly startingResources?: Readonly<Record<string, number>>;
  readonly openingHook?: ExtensionWorldI18nText;
  readonly openingChips?: readonly ExtensionWorldI18nText[];
}

export interface ExtensionWorldDimensions {
  readonly geography?: ExtensionWorldGeography;
  readonly factions?: ExtensionWorldFaction[];
  readonly powerSystem?: ExtensionWorldPowerSystem;
  readonly history?: ExtensionWorldHistoryEvent[];
  readonly economy?: ExtensionWorldEconomy;
  readonly socialStructure?: ExtensionWorldSocialStructure;
  readonly tone?: ExtensionWorldTone;
  readonly mechanics?: ExtensionWorldMechanics;
  readonly startingConditions?: ExtensionWorldStartingConditions;
}
