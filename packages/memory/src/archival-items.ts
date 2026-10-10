import { characterLabel, modelFacingJson } from "@covel/plugin-handlers-utils";
import type { ArchivalStore } from "./store-contracts.js";

export interface ArchivalItem {
  readonly vecKey: string;
  readonly displayKey: string;
  readonly text: string;
  readonly source: "lorebook" | "character" | "plugin_data";
  readonly pluginId?: string;
  readonly namespace?: string;
}

/**
 * A plugin data namespace that its plugin declared searchable
 * (`contributes.data.<namespace>.search`). The host resolves the list for a
 * session from the plugins active in it, so the memory package names no plugin.
 */
export interface SearchablePluginData {
  readonly pluginId: string;
  readonly namespace: string;
  /** Field of a record's value that holds the text to search. */
  readonly textField: string;
}

export type SearchablePluginDataResolver = (
  sessionId: string,
) => Promise<readonly SearchablePluginData[]>;

export async function lorebookItems(
  store: ArchivalStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  const items: ArchivalItem[] = [];
  for (const entry of await store.listSessionLorebookEntries(sessionId)) {
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
  return items;
}

export async function characterItems(
  store: ArchivalStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  const items: ArchivalItem[] = [];
  for (const char of await store.listCharacters(sessionId)) {
    const text =
      `[${char.type}] ${characterLabel(char)}: ${char.description ?? ""} ${JSON.stringify(modelFacingJson(char.fields ?? {}))}`.trim();
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

/** Records of the namespaces that active plugins declared searchable. */
export async function pluginDataItems(
  store: ArchivalStore,
  sessionId: string,
  resolve: SearchablePluginDataResolver | undefined,
): Promise<ArchivalItem[]> {
  if (!resolve) return [];
  const items: ArchivalItem[] = [];
  for (const source of await resolve(sessionId)) {
    const rows = await store.listPluginData(
      sessionId,
      source.pluginId,
      source.namespace,
    );
    for (const row of rows) {
      const value = row.value;
      if (value === null || typeof value !== "object") continue;
      const raw = (value as Record<string, unknown>)[source.textField];
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) continue;
      items.push({
        vecKey: `plugin:${source.pluginId}:${source.namespace}:${row.key}`,
        displayKey: row.key,
        text,
        source: "plugin_data",
        pluginId: source.pluginId,
        namespace: source.namespace,
      });
    }
  }
  return items;
}

/**
 * The whole archival corpus. Deletion detection in the vector index needs
 * every source read to succeed, so a failed read throws here and the sweep's
 * archival catch runs before any vector or hash can change.
 */
export async function collectArchivalItems(
  store: ArchivalStore,
  sessionId: string,
  pluginData?: SearchablePluginDataResolver,
): Promise<ArchivalItem[]> {
  return [
    ...(await lorebookItems(store, sessionId)),
    ...(await characterItems(store, sessionId)),
    ...(await pluginDataItems(store, sessionId, pluginData)),
  ];
}
