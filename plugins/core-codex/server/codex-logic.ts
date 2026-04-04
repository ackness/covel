/**
 * Pure business logic for codex/encyclopedia management.
 * All functions are immutable — they return new state objects.
 */

export type CodexCategory = "monster" | "item" | "location" | "lore" | "character";

export interface CodexEntry {
  readonly entryId: string;
  readonly category: CodexCategory;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly imageHint?: string;
  readonly discoveredAt: string;
  readonly updatedAt?: string;
}

export interface CodexState {
  readonly entries: readonly CodexEntry[];
}

export const EMPTY_STATE: CodexState = { entries: [] };

export interface UnlockEntryInput {
  readonly category: CodexCategory;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly imageHint?: string;
}

export interface UnlockEntryResult {
  readonly state: CodexState;
  readonly entry: CodexEntry;
}

/**
 * Create a new codex entry.
 * Returns a new state with the entry appended.
 */
export function unlockEntry(
  state: CodexState,
  input: UnlockEntryInput,
  generateId: () => string = () => crypto.randomUUID(),
): UnlockEntryResult {
  const entry: CodexEntry = {
    entryId: generateId(),
    category: input.category,
    title: input.title,
    content: input.content,
    tags: [...input.tags],
    imageHint: input.imageHint,
    discoveredAt: new Date().toISOString(),
  };

  const newState: CodexState = {
    entries: [...state.entries, entry],
  };

  return { state: newState, entry };
}

/**
 * Update an existing codex entry's content, tags, or imageHint.
 * Sets updatedAt timestamp. Throws if entry not found.
 */
export function updateEntry(
  state: CodexState,
  entryId: string,
  updates: Partial<Pick<CodexEntry, "content" | "tags" | "imageHint">>,
): CodexState {
  const entryIndex = state.entries.findIndex((e) => e.entryId === entryId);
  if (entryIndex === -1) {
    throw new Error(`Codex entry not found: ${entryId}`);
  }

  const existing = state.entries[entryIndex];
  const updatedEntry: CodexEntry = {
    ...existing,
    content: updates.content ?? existing.content,
    tags: updates.tags ? [...updates.tags] : existing.tags,
    imageHint: updates.imageHint ?? existing.imageHint,
    updatedAt: new Date().toISOString(),
  };

  const newEntries = state.entries.map((e, i) =>
    i === entryIndex ? updatedEntry : e,
  );

  return { entries: newEntries };
}

/**
 * Get entries filtered by category.
 */
export function getEntriesByCategory(
  state: CodexState,
  category: CodexCategory,
): readonly CodexEntry[] {
  return state.entries.filter((e) => e.category === category);
}

/**
 * Find an entry by title using fuzzy match (case-insensitive substring).
 * Returns the first matching entry or undefined.
 */
export function findEntryByTitle(
  state: CodexState,
  title: string,
): CodexEntry | undefined {
  const lower = title.toLowerCase();
  return state.entries.find((e) => e.title.toLowerCase().includes(lower));
}

/**
 * Build a human-readable codex summary grouped by category for context injection.
 */
export function getCodexSummary(state: CodexState, locale: string): string {
  const isZh = locale.startsWith("zh");

  if (state.entries.length === 0) {
    return isZh ? "尚未发现任何图鉴条目。" : "No codex entries discovered yet.";
  }

  const categoryLabels: Record<CodexCategory, { zh: string; en: string }> = {
    monster: { zh: "怪物", en: "Monster" },
    item: { zh: "道具", en: "Item" },
    location: { zh: "地点", en: "Location" },
    lore: { zh: "传说", en: "Lore" },
    character: { zh: "人物", en: "Character" },
  };

  const categories: CodexCategory[] = ["monster", "item", "location", "lore", "character"];
  const lines: string[] = [];

  for (const category of categories) {
    const entries = getEntriesByCategory(state, category);
    if (entries.length === 0) continue;

    const label = isZh ? categoryLabels[category].zh : categoryLabels[category].en;
    lines.push(`## ${label}`);

    for (const entry of entries) {
      const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      lines.push(`- **${entry.title}**${tagStr}: ${entry.content}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
