export type CharacterType = "player" | "npc" | "companion";

export interface CharacterCard {
  id: string;
  worldId: string;
  runId: string;
  name: string;
  type: CharacterType;
  description: string;
  portrait?: string;
  /** Dynamic fields constrained by world characterSchema */
  fields: Record<string, unknown>;
  /** Plugin-namespaced extension data */
  extensions: Record<string, unknown>;
  createdAt: string;
  version: number;
}

export interface CharacterRelationship {
  id: string;
  fromCharacterId: string;
  toCharacterId: string;
  type: string;
  affinity?: number;
  notes?: string;
  lastInteractionTurnId?: string;
}

export interface CharacterCreateInput {
  name: string;
  type?: CharacterType;
  description?: string;
  fields?: Record<string, unknown>;
}
