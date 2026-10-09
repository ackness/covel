import type { DataStore } from "@covel/store/contracts";

/** Only the persistence capabilities used by each memory tier. */
export type RecallStore = Pick<
  DataStore,
  "listRecentTurnMessages" | "listSessionSummaries"
>;
export type ArchivalStore = Pick<
  DataStore,
  "listSessionLorebookEntries" | "listCharacters" | "listPluginData"
>;

export interface VectorIngestStore
  extends
    ArchivalStore,
    Pick<DataStore, "getSession" | "listTurnMessagesAfter"> {}

export interface MemoryStore extends RecallStore, VectorIngestStore {}
