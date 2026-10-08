import type { ArchivalStore } from "./store-contracts.js";

export interface ArchivalItem {
  readonly vecKey: string;
  readonly displayKey: string;
  readonly text: string;
  readonly source: "lorebook" | "character";
  readonly pluginId?: string;
}

export async function collectArchivalItems(
  store: ArchivalStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  const items: ArchivalItem[] = [];

  // Deletion detection needs both complete source reads. Let failures reach
  // the sweep's archival catch before any vectors or hashes can be changed.
  // Lorebook entries. plugin_data is intentionally excluded (same isolation
  // reasoning as the keyword archival searcher — no plugin-agnostic way to scan
  // every plugin's namespaced data).
  const entries = await store.listSessionLorebookEntries(sessionId);
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const content = String(entry.content ?? "").trim();
    if (!content) continue;
    items.push({
      vecKey: `lorebook:${JSON.stringify(entry.owner)}:${entry.id}`,
      displayKey: entry.keys?.[0] ?? entry.id,
      text: content,
      source: "lorebook",
      ...(entry.owner.kind === "plugin"
        ? { pluginId: entry.owner.pluginId }
        : {}),
    });
  }

  // Character records.
  const characters = await store.listCharacters(sessionId);
  for (const char of characters) {
    const text =
      `[${char.type}] ${char.name}: ${char.description ?? ""} ${JSON.stringify(char.fields ?? {})}`.trim();
    if (!text) continue;
    items.push({
      vecKey: `character:${char.id}`,
      displayKey: char.name,
      text,
      source: "character",
    });
  }

  return items;
}
