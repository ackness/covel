import type { CharacterRecord } from "@covel/store";
import { mergeCharacterAliases } from "@covel/shared";
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * The creation time of the `order`-th character of one import. The roster
 * lists characters by creation time, then by ID, so characters that share one
 * instant list by ID. One millisecond apart, they list as the author wrote
 * them.
 */
function createdAtInOrder(now: string, order: number): string {
  const time = Date.parse(now);
  return Number.isFinite(time) ? new Date(time + order).toISOString() : now;
}

export function characterRecordFromValue(
  sessionId: string,
  value: unknown,
  now: string,
  /** The place of this record among the characters of the same import. */
  order = 0,
): CharacterRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!id || !name) return null;
  const aliases = mergeCharacterAliases(
    name,
    [],
    Array.isArray(value.aliases)
      ? value.aliases.filter(
          (alias): alias is string => typeof alias === "string",
        )
      : [],
  );
  return {
    // Character keys are per session already; the world's own id is used
    // as is, so prompts carry `npc-mio`, not `<sessionId>-npc-mio`.
    id,
    sessionId,
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    type: typeof value.type === "string" ? value.type : "npc",
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(value.fields !== undefined ? { fields: value.fields } : {}),
    version: typeof value.version === "number" ? value.version : 1,
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : createdAtInOrder(now, order),
    updatedAt: now,
  };
}
