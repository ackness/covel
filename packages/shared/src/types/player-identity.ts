import type { CharacterUpsertPayload } from "./proposal.js";

export interface PlayerIdentityCoordinate {
  readonly position: "seg3_prepend" | "seg3_append" | "at_depth";
  readonly depth?: number;
  readonly order?: number;
}

export interface PlayerIdentityProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly voice?: string;
  readonly goals?: readonly string[];
  readonly boundaries?: readonly string[];
  readonly relationshipTone?: string;
  readonly promptCoordinate?: PlayerIdentityCoordinate;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PlayerIdentityRecord {
  readonly profile: PlayerIdentityProfile;
  readonly updatedAt: string;
  readonly boundCharacterId?: string;
}

export interface PlayerIdentityBinding {
  readonly profileId: string;
  readonly characterId?: string;
  readonly updatedAt: string;
}

export interface PlayerIdentitySavePayload {
  readonly profile?: PlayerIdentityProfile;
  readonly profileJson?: string;
  readonly activate?: boolean;
  readonly bindToPlayer?: boolean;
}

export interface PlayerIdentitySaveResult {
  readonly saved: boolean;
  readonly profileId: string;
  readonly activated: boolean;
  readonly characterId?: string;
}

export function playerIdentityToCharacterUpsert(
  profile: PlayerIdentityProfile,
  opts: {
    readonly existingPlayer?: {
      readonly id: string;
      readonly name: string;
      readonly type?: string;
      readonly description?: string;
      readonly fields?: unknown;
      readonly version?: number;
      readonly createdAt?: string;
    };
    readonly now?: string;
    readonly mirrorPluginId?: string;
  } = {},
): CharacterUpsertPayload {
  const existing = opts.existingPlayer;
  const fields = {
    ...(isRecord(existing?.fields) ? existing.fields : {}),
    ...profile.fields,
    identityProfileId: profile.id,
    identityProfileName: profile.name,
  };

  return {
    id: existing?.id ?? `player-${profile.id}`,
    name: existing?.name ?? profile.name,
    type: "player",
    ...((profile.description ?? existing?.description)
      ? { description: profile.description ?? existing?.description }
      : {}),
    fields,
    version: existing?.version ?? 1,
    ...((existing?.createdAt ?? opts.now)
      ? { createdAt: existing?.createdAt ?? opts.now }
      : {}),
    ...(opts.mirrorPluginId ? { mirrorPluginId: opts.mirrorPluginId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
