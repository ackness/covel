import type { MediaRef } from './media.js';

export interface CharacterPresenceMediaRefs {
  readonly avatar?: MediaRef;
  readonly sprite?: MediaRef;
  readonly voice?: MediaRef;
  readonly media?: Readonly<Record<string, MediaRef>>;
}

export interface CharacterPresence extends CharacterPresenceMediaRefs {
  readonly schemaVersion: 1;
  readonly characterId: string;
  readonly displayName?: string;
  readonly style?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CharacterPresenceRecord {
  readonly presence: CharacterPresence;
  readonly updatedAt: string;
}

export interface CharacterPresenceSavePayload {
  readonly presence?: CharacterPresence;
  readonly presenceJson?: string;
}

export interface CharacterPresenceSaveResult {
  readonly saved: boolean;
  readonly characterId: string;
}
