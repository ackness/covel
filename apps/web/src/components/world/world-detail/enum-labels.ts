import type { DetailTranslate } from "./detail-primitives.js";

const ENUM_LABEL_KEYS = {
  factionType: {
    political: "world.factionTypePolitical",
    guild: "world.factionTypeGuild",
    corporate: "world.factionTypeCorporate",
    religious: "world.factionTypeReligious",
    criminal: "world.factionTypeCriminal",
    military: "world.factionTypeMilitary",
    other: "world.factionTypeOther",
  },
  influence: {
    major: "world.influenceMajor",
    minor: "world.influenceMinor",
  },
  relation: {
    allied: "world.relationAllied",
    neutral: "world.relationNeutral",
    hostile: "world.relationHostile",
    vassal: "world.relationVassal",
  },
  powerType: {
    magic: "world.powerTypeMagic",
    technology: "world.powerTypeTechnology",
    cultivation: "world.powerTypeCultivation",
    psychic: "world.powerTypePsychic",
    hybrid: "world.powerTypeHybrid",
    other: "world.powerTypeOther",
  },
  significance: {
    major: "world.significanceMajor",
    minor: "world.significanceMinor",
  },
  rating: {
    "all-ages": "world.ratingAllAges",
    teen: "world.ratingTeen",
    mature: "world.ratingMature",
  },
  combat: {
    "turn-based": "world.combatTurnBased",
    "real-time": "world.combatRealTime",
    narrative: "world.combatNarrative",
    none: "world.combatNone",
  },
  difficulty: {
    easy: "world.difficultyEasy",
    normal: "world.difficultyNormal",
    hard: "world.difficultyHard",
    adaptive: "world.difficultyAdaptive",
  },
} as const;

export type WorldEnumKind = keyof typeof ENUM_LABEL_KEYS;

export function worldEnumLabel(
  t: DetailTranslate,
  kind: WorldEnumKind,
  value: string,
): string {
  const keys = ENUM_LABEL_KEYS[kind] as Record<string, string>;
  const key = keys[value];
  return key ? t(key) : value;
}
