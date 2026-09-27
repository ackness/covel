import type { LorebookEntryRecord, StoreTransaction } from "@covel/store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Import portable lorebook rows embedded in a generated WorldRecord.
 *
 * File-backed worlds use their worldData descriptor. Store-only and browser
 * worlds have no durable package directory, so the AI route carries the same
 * validated text rows in `metadata.embeddedLorebook` for this fallback.
 */
export async function importWorldEmbeddedLorebook(
  store: StoreTransaction,
  sessionId: string,
  worldId: string | undefined,
  now: string,
): Promise<void> {
  if (!worldId) return;
  const world = await store.getWorld(worldId);
  const candidates =
    isRecord(world?.metadata) && Array.isArray(world.metadata.embeddedLorebook)
      ? world.metadata.embeddedLorebook.slice(0, 128)
      : [];
  const seen = new Set<string>();
  const records: LorebookEntryRecord[] = [];
  for (const [index, value] of candidates.entries()) {
    if (!isRecord(value)) continue;
    if (typeof value.id !== "string" || !value.id || seen.has(value.id)) {
      continue;
    }
    if (typeof value.content !== "string" || !value.content) continue;
    seen.add(value.id);
    const keys = Array.isArray(value.keys)
      ? value.keys
          .filter((key): key is string => typeof key === "string")
          .slice(0, 32)
      : [];
    records.push({
      id: value.id,
      sessionId,
      owner: { kind: "world" },
      keys,
      content: value.content,
      strategy: value.strategy === "selective" ? "selective" : "constant",
      position:
        value.position === "before_plugin" ? "before_plugin" : "after_plugin",
      insertionOrder:
        typeof value.insertionOrder === "number"
          ? value.insertionOrder
          : 100 + index,
      enabled: value.enabled !== false,
      ...(value.extra !== undefined ? { extra: value.extra } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  if (records.length > 0) {
    await store.upsertLorebookEntries(records);
  }
}
