import type { CharacterUpsertPayload } from "./proposal.js";
import type { MediaRef } from "./media.js";

export type CharacterBlueprintRole =
  | "player"
  | "npc"
  | "companion"
  | (string & {});

export interface CharacterBlueprintI18nText {
  readonly default: string;
  readonly translations?: Readonly<Record<string, string>>;
}

export interface CharacterBlueprintPersona {
  readonly summary?: string;
  readonly traits?: readonly string[];
  readonly goals?: readonly string[];
  readonly fears?: readonly string[];
  readonly secrets?: readonly string[];
  readonly voice?: string;
  readonly style?: string;
  readonly notes?: readonly string[];
}

export interface CharacterBlueprintDialogueExample {
  readonly id?: string;
  readonly user?: string;
  readonly character: string;
  readonly context?: string;
  readonly tags?: readonly string[];
}

export interface CharacterBlueprintScenarioDefaults {
  readonly opening?: string;
  readonly location?: string;
  readonly relationships?: Readonly<Record<string, unknown>>;
  readonly inventory?: readonly string[];
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface CharacterBlueprintRule {
  readonly id?: string;
  readonly text: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
}

export interface CharacterBlueprintMediaRefs {
  readonly portrait?: MediaRef;
  readonly gallery?: readonly MediaRef[];
  readonly voice?: MediaRef;
  readonly themeAudio?: MediaRef;
  readonly refs?: readonly MediaRef[];
}

export interface CharacterBlueprintInstantiation {
  readonly characterId?: string;
  readonly name?: string;
  readonly type?: CharacterBlueprintRole;
  readonly description?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly mirrorPluginId?: string;
}

export interface CharacterBlueprint {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly role?: CharacterBlueprintRole;
  readonly description?: string;
  readonly source?: string;
  readonly locale?: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly persona?: CharacterBlueprintPersona;
  readonly dialogueExamples?: readonly CharacterBlueprintDialogueExample[];
  readonly scenarioDefaults?: CharacterBlueprintScenarioDefaults;
  readonly rules?: readonly CharacterBlueprintRule[];
  readonly media?: CharacterBlueprintMediaRefs;
  readonly instantiate?: CharacterBlueprintInstantiation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CharacterBlueprintRecord {
  readonly blueprint: CharacterBlueprint;
  readonly importedAt: string;
  readonly instantiatedCharacterId?: string;
}

export interface CharacterBlueprintImportPayload {
  readonly blueprint: CharacterBlueprint;
  readonly instantiate?: boolean;
}

export interface CharacterBlueprintImportResult {
  readonly imported: boolean;
  readonly blueprintId: string;
  readonly instantiated: boolean;
  readonly characterId?: string;
}

export function characterBlueprintToCharacterUpsert(
  blueprint: CharacterBlueprint,
  opts: {
    readonly sessionId?: string;
    readonly now?: string;
    readonly characterId?: string;
    readonly mirrorPluginId?: string;
  } = {},
): CharacterUpsertPayload {
  const instantiate = blueprint.instantiate;
  const id =
    opts.characterId ?? instantiate?.characterId ?? `char-${blueprint.id}`;
  const type = instantiate?.type ?? blueprint.role ?? "npc";
  const description = instantiate?.description ?? blueprint.description;
  const fields = instantiate?.fields ?? blueprint.attributes;
  return {
    id,
    name: instantiate?.name ?? blueprint.name,
    type,
    ...(description !== undefined ? { description } : {}),
    ...(fields !== undefined ? { fields } : {}),
    version: 1,
    ...(opts.now ? { createdAt: opts.now } : {}),
    ...((opts.mirrorPluginId ?? instantiate?.mirrorPluginId)
      ? { mirrorPluginId: opts.mirrorPluginId ?? instantiate?.mirrorPluginId }
      : {}),
  };
}
