import type { CharacterRecord } from "../types/character-record.js";
import type { CharacterUpsertPayload } from "../types/proposal.js";
import {
  characterNameKey,
  mergeCharacterAliases,
} from "@covel/plugin-handlers-utils";

/**
 * Materialize one character instruction without mutating its inputs.
 * Versioned writes patch the current record (fields merge, `removeAliases`
 * are taken away, then `aliases` are added); unversioned writes replace it.
 * The commit boundary owns validation, including expected-version checks.
 */
export function materializeCharacterUpsert(
  payload: CharacterUpsertPayload,
  current: CharacterRecord | undefined,
  sessionId: string,
  now: string,
): CharacterRecord {
  const live = payload.expectedVersion !== undefined ? current : undefined;
  const liveFields = asFieldsRecord(live?.fields);
  const fieldPatch = asFieldsRecord(payload.fields);
  const fields = live
    ? payload.fields === undefined
      ? live.fields
      : liveFields && fieldPatch
        ? { ...liveFields, ...fieldPatch }
        : payload.fields
    : payload.fields;
  const name = live?.name ?? payload.name;
  const removed = new Set((payload.removeAliases ?? []).map(characterNameKey));
  const kept = (live?.aliases ?? []).filter(
    (alias) => !removed.has(characterNameKey(alias)),
  );
  const aliases = mergeCharacterAliases(name, kept, payload.aliases);
  return {
    id: payload.id,
    sessionId,
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    type: live?.type ?? payload.type ?? "npc",
    ...(payload.description !== undefined || live?.description !== undefined
      ? { description: payload.description ?? live?.description }
      : {}),
    ...(fields != null ? { fields } : {}),
    version: live ? live.version + 1 : (payload.version ?? 1),
    createdAt: live?.createdAt ?? payload.createdAt ?? now,
    updatedAt: now,
  };
}

function asFieldsRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
