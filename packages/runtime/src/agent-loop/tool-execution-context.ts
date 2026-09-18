import type { DataStore } from "@covel/store";
import type { ToolExecutionContext } from "@covel/tools";
import type { FunctionStoreView } from "@covel/shared/plugin-runtime";
import { createFunctionStoreView } from "../function-runtime/plugin-handler-helpers.js";
import type { ToolCallContext } from "./tool-executor.js";

/** Own input snapshots and bind read authority to this invocation's identity. */
export function createToolExecutionContext(
  caller: ToolCallContext,
  store: DataStore | undefined,
) {
  let closed = false;
  const pendingReads = new Set<Promise<unknown>>();
  const signal = caller.signal;
  const identity = {
    sessionId: caller.sessionId,
    turnId: caller.turnId,
    pluginId: caller.pluginId,
    runtimeId: caller.runtimeId,
  };
  const pending = structuredClone(
    (caller.pendingProposals ?? []).filter(
      (proposal) => proposal.sessionId === identity.sessionId,
    ),
  );
  function assertLive() {
    signal?.throwIfAborted();
    if (closed) throw new Error("Tool invocation has completed");
  }
  function read<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      assertLive();
      const value = await operation();
      // A read already in flight must not deliver state after cancellation.
      assertLive();
      return value;
    })();
    pendingReads.add(pending);
    // Observe even reads the plugin forgot to await, while preserving rejection
    // for its caller. The host owns their I/O until the tool call settles.
    void pending.then(
      () => pendingReads.delete(pending),
      () => pendingReads.delete(pending),
    );
    return pending;
  }
  let view: FunctionStoreView | undefined;
  if (store) {
    // Keep the overlay separate from the copy exposed to plugin code.
    const reads = createFunctionStoreView(store, identity, pending);
    view = Object.freeze({
      getPluginData: (namespace: string, key: string) =>
        read(() => reads.getPluginData(namespace, key)),
      listPluginData: (namespace: string) =>
        read(() => reads.listPluginData(namespace)),
      getSession: () => read(() => reads.getSession()),
      listPlayerInputs: () => read(() => reads.listPlayerInputs()),
      listTurnMessages: (limit?: number) =>
        read(() => reads.listTurnMessages(limit)),
    });
  }
  const context: ToolExecutionContext = Object.freeze({
    ...identity,
    inputSlots: structuredClone(caller.inputSlots),
    pendingProposals: structuredClone(pending),
    emittedEventTopics: structuredClone(caller.emittedEventTopics),
    ...(caller.turnNumber !== undefined
      ? { turnNumber: caller.turnNumber }
      : {}),
    signal,
    ...(view ? { store: view } : {}),
  });
  return {
    context,
    assertLive,
    close() {
      closed = true;
    },
    async drain() {
      await Promise.allSettled(pendingReads);
    },
  };
}
