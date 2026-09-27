import type { CharacterRecord } from "@covel/store";
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function characterRecordFromValue(
  sessionId: string,
  value: unknown,
  now: string,
): CharacterRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!id || !name) return null;
  return {
    id: `${sessionId}-${id}`,
    sessionId,
    name,
    type: typeof value.type === "string" ? value.type : "npc",
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(value.fields !== undefined ? { fields: value.fields } : {}),
    version: typeof value.version === "number" ? value.version : 1,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: now,
  };
}
