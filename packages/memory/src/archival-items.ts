import { characterLabel, modelFacingJson } from "@covel/plugin-handlers-utils";
import type {
  CharacterRecord,
  LorebookEntryRecord,
  LorebookOwner,
  PluginDataRecord,
} from "@covel/store/contracts";
import type { ArchivalLookupStore, ArchivalStore } from "./store-contracts.js";

export interface ArchivalItem {
  readonly vecKey: string;
  readonly displayKey?: string;
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

/** The record an archival item is made from; also the change the store reports for it. */
export type ArchivalRef =
  | {
      readonly kind: "lorebook";
      readonly owner: LorebookOwner;
      readonly id: string;
    }
  | { readonly kind: "character"; readonly id: string }
  | {
      readonly kind: "plugin_data";
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
    };

/** The vector key of a record: its identity, so a search hit names the record to read. */
export function archivalVecKey(ref: ArchivalRef): string {
  switch (ref.kind) {
    case "lorebook":
      return JSON.stringify(["lorebook", ref.owner, ref.id]);
    case "character":
      return JSON.stringify(["character", ref.id]);
    case "plugin_data":
      return JSON.stringify([
        "plugin_data",
        ref.pluginId,
        ref.namespace,
        ref.key,
      ]);
  }
}

export function parseArchivalVecKey(vecKey: string): ArchivalRef | null {
  let parts: unknown;
  try {
    parts = JSON.parse(vecKey);
  } catch {
    return null;
  }
  if (!Array.isArray(parts)) return null;
  const [kind, a, b, c] = parts as unknown[];
  const text = (value: unknown): value is string => typeof value === "string";
  if (kind === "lorebook" && isLorebookOwner(a) && text(b))
    return { kind, owner: a, id: b };
  if (kind === "character" && text(a)) return { kind, id: a };
  if (kind === "plugin_data" && text(a) && text(b) && text(c))
    return { kind, pluginId: a, namespace: b, key: c };
  return null;
}

function isLorebookOwner(value: unknown): value is LorebookOwner {
  if (value === null || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return owner.kind === "plugin"
    ? typeof owner.pluginId === "string"
    : owner.kind === "world" || owner.kind === "player";
}

/** Key of a searchable namespace in a lookup of the session's sources. */
export function searchableSourceKey(
  pluginId: string,
  namespace: string,
): string {
  return JSON.stringify([pluginId, namespace]);
}

/** Apply the ID projection before relabelling a storage key for the model. */
function displayKey(id: string): string | undefined {
  return modelFacingJson({ id }).id || undefined;
}

/** The item of a lorebook entry, or null when it is disabled or empty. */
function lorebookItem(entry: LorebookEntryRecord): ArchivalItem | null {
  if (!entry.enabled) return null;
  const content = String(entry.content ?? "").trim();
  if (!content) return null;
  return {
    vecKey: archivalVecKey({
      kind: "lorebook",
      owner: entry.owner,
      id: entry.id,
    }),
    displayKey: displayKey(entry.keys?.[0] || entry.id),
    text: content,
    source: "lorebook",
    ...(entry.owner.kind === "plugin"
      ? { pluginId: entry.owner.pluginId }
      : {}),
  };
}

function characterItem(char: CharacterRecord): ArchivalItem | null {
  const text =
    `[${char.type}] ${characterLabel(char)}: ${char.description ?? ""} ${JSON.stringify(modelFacingJson(char.fields ?? {}))}`.trim();
  if (!text) return null;
  return {
    vecKey: archivalVecKey({ kind: "character", id: char.id }),
    displayKey: char.name,
    text,
    source: "character",
  };
}

/** The item of a searchable plugin data record, or null when its text field is empty. */
function pluginDataItem(
  row: PluginDataRecord,
  source: SearchablePluginData,
): ArchivalItem | null {
  const value = row.value;
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[source.textField];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  return {
    vecKey: archivalVecKey({
      kind: "plugin_data",
      pluginId: source.pluginId,
      namespace: source.namespace,
      key: row.key,
    }),
    displayKey: displayKey(row.key),
    text,
    source: "plugin_data",
    pluginId: source.pluginId,
    namespace: source.namespace,
  };
}

/**
 * The current item of one record, or null when the record is gone or yields
 * no text. A plugin data record counts only while its namespace is among
 * `sources` (the session's searchable namespaces). A failed read throws.
 */
export async function readArchivalItem(
  store: ArchivalLookupStore,
  sessionId: string,
  ref: ArchivalRef,
  sources: ReadonlyMap<string, SearchablePluginData>,
): Promise<ArchivalItem | null> {
  switch (ref.kind) {
    case "lorebook": {
      const entry = await store.getLorebookEntry(sessionId, ref.owner, ref.id);
      return entry ? lorebookItem(entry) : null;
    }
    case "character": {
      const char = await store.getCharacter(sessionId, ref.id);
      return char ? characterItem(char) : null;
    }
    case "plugin_data": {
      const source = sources.get(
        searchableSourceKey(ref.pluginId, ref.namespace),
      );
      if (!source) return null;
      const row = await store.getPluginData(
        sessionId,
        ref.pluginId,
        ref.namespace,
        ref.key,
      );
      return row ? pluginDataItem(row, source) : null;
    }
  }
}

export async function lorebookItems(
  store: ArchivalStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  return (await store.listSessionLorebookEntries(sessionId)).flatMap(
    (entry) => lorebookItem(entry) ?? [],
  );
}

export async function characterItems(
  store: ArchivalStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  return (await store.listCharacters(sessionId)).flatMap(
    (char) => characterItem(char) ?? [],
  );
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
      const item = pluginDataItem(row, source);
      if (item) items.push(item);
    }
  }
  return items;
}
