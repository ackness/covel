import type { AttributeDefinition } from "./character-schema.js";

/** Authoritative session character schema. Version advances on replacement. */
export interface CharacterSchema {
  readonly version: number;
  /** Non-player types; the reserved player type is always available. */
  readonly types: readonly string[];
  readonly attributes: readonly AttributeDefinition[];
}

export interface CharacterSchemaRecord extends CharacterSchema {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LorebookOwner =
  | { readonly kind: "world" }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | { readonly kind: "player" };
