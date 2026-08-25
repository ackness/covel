import type { DataStore, SuspensionRecord } from "@covel/store";

/**
 * Keep continuations private until the execution's proposal transaction lands.
 * Runtime code still calls `saveSuspension`, but this execution-scoped store
 * view stages the record for `finalizeExecution` instead of publishing it
 * before sibling proposals are known to be committable.
 */
export function stageExecutionSuspensions(store: DataStore): {
  readonly store: DataStore;
  readonly records: readonly SuspensionRecord[];
} {
  const staged = new Map<string, SuspensionRecord>();
  const executionStore = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "saveSuspension") {
        return async (record: SuspensionRecord): Promise<void> => {
          staged.set(record.id, record);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    store: executionStore,
    get records() {
      return [...staged.values()];
    },
  };
}
