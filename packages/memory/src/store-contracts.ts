import type { DataStore } from "@covel/store/contracts";

/** Only the persistence capabilities used by each memory tier. */
export type RecallStore = Pick<DataStore, "listRecentTurnMessages">;
export type ArchivalStore = Pick<
  DataStore,
  "listSessionLorebookEntries" | "listCharacters"
>;

export interface CoreMemoryStore extends Pick<
  DataStore,
  | "getWorkingMemory"
  | "listWorkingMemory"
  | "upsertWorkingMemory"
  | "setPluginData"
> {
  /** A batch of authoritative block writes must remain atomic. */
  withTransaction<T>(
    fn: (tx: Pick<DataStore, "upsertWorkingMemory">) => Promise<T>,
  ): Promise<T>;
}

export interface VectorIngestStore
  extends
    ArchivalStore,
    Pick<
      DataStore,
      "getSession" | "listTurnMessagesAfter" | "getPluginData" | "setPluginData"
    > {}

export interface MemoryStore
  extends CoreMemoryStore, RecallStore, VectorIngestStore {}
