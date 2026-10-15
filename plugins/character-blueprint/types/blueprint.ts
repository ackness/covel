/**
 * The roleplay notes of one character: the `blueprint` field of its record
 * in the world's character file, stored in `blueprints` under the
 * character's id. The record gives the name, type, description and fields.
 */

export interface CharacterBlueprintPersona {
  readonly summary?: string;
  readonly traits?: readonly string[];
  readonly goals?: readonly string[];
  readonly fears?: readonly string[];
  readonly secrets?: readonly string[];
  readonly voice?: string;
  readonly style?: string;
}

export interface CharacterBlueprintDialogueExample {
  readonly id?: string;
  readonly user?: string;
  readonly character: string;
}

export interface CharacterBlueprintScenarioDefaults {
  readonly opening?: string;
  readonly location?: string;
  /** By `player`, a character's id or a dimension entry's id. */
  readonly relationships?: Readonly<Record<string, string>>;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

export interface CharacterBlueprintRule {
  readonly id?: string;
  readonly text: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
}

export interface CharacterBlueprint {
  readonly tags?: readonly string[];
  readonly persona?: CharacterBlueprintPersona;
  readonly dialogueExamples?: readonly CharacterBlueprintDialogueExample[];
  readonly scenarioDefaults?: CharacterBlueprintScenarioDefaults;
  readonly rules?: readonly CharacterBlueprintRule[];
}
