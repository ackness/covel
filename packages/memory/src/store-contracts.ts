import type { DataStore } from "@covel/store/contracts";

/** Only the persistence capabilities used by each memory tier. */
export type RecallStore = Pick<
  DataStore,
  "listRecentTurnMessages" | "listSessionSummaries"
>;
/** The whole archival corpus, for keyword search. */
export type ArchivalStore = Pick<
  DataStore,
  "listSessionLorebookEntries" | "listCharacters" | "listPluginData"
>;
/** One archival record by its identity, for checking a vector hit or a change. */
export type ArchivalLookupStore = Pick<
  DataStore,
  "getLorebookEntry" | "getCharacter" | "getPluginData"
>;

export interface VectorIngestStore
  extends
    ArchivalLookupStore,
    Pick<
      DataStore,
      "getSession" | "listTurnMessagesAfter" | "listRecordChanges"
    > {}

export interface MemoryStore
  extends RecallStore, ArchivalStore, VectorIngestStore {}
