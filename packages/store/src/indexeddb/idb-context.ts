import type { DataStore } from "../types.js";
import type { BrowserIdbDatabase } from "./idb-db.js";
import type { IdbMutationTracker } from "./idb-transaction.js";

export interface IdbStoreContext {
  readonly db: BrowserIdbDatabase;
  readonly mutations: IdbMutationTracker;
}

export type IdbStoreSlice = Partial<DataStore>;
