import { snapshotWorldModelView } from "../function-runtime/world-model-view.js";
import { CharacterHistoryReader } from "../orchestration/character-history.js";
import type { DataStore } from "@covel/store";
import type { ToolExecutionContext } from "@covel/tools";
import type { FunctionStoreView } from "@covel/shared/plugin-runtime";
import { createFunctionStoreView } from "../function-runtime/plugin-handler-helpers.js";
import { createPluginRandom } from "../function-runtime/plugin-random.js";
import type { ToolCallContext } from "./tool-executor.js";
import { combineAbortSignals } from "../turn-executor/turn-control.js";

/** Own input snapshots and bind read authority to this invocation's identity. */
export function createToolExecutionContext(
  caller: ToolCallContext,
  store: DataStore | undefined,
  toolCallId?: string,
): {
  context: ToolExecutionContext;
  assertLive(): void;
  close(): void;
  drain(): Promise<void>;
} {
  let closed = false;
  const pendingReads = new Set<Promise<unknown>>();
  const signal = caller.signal;
  // Service calls end with the invocation: one the tool did not await is
  // cancelled when the tool returns, and `drain` waits for it to settle.
  const invocation = new AbortController();
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
    // Keep the overlay separate from the copy exposed to plugin code. Reads
    // include the caller plugin's upstream writes and record what they saw.
    const reads = createFunctionStoreView(
      store,
      identity,
      pending,
      caller.pluginDataVisibility,
    );
    view = Object.freeze({
      getPluginData: (namespace: string, key: string) =>
        read(() => reads.getPluginData(namespace, key)),
      listPluginData: (namespace: string) =>
        read(() => reads.listPluginData(namespace)),
      getSession: () => read(() => reads.getSession()),
      listPlayerInputs: () => read(() => reads.listPlayerInputs()),
      listTurnMessages: (limit?: number) =>
        read(() => reads.listTurnMessages(limit)),
      readTurnMessages: (
        options?: Parameters<FunctionStoreView["readTurnMessages"]>[0],
      ) => read(() => reads.readTurnMessages(options)),
    });
  }
  const worldSnapshot = caller.world
    ? snapshotWorldModelView(caller.world, assertLive)
    : undefined;
  let services: ToolExecutionContext["services"];
  if (caller.services) {
    // The tool's plugin and runtime are the caller, with the same read scope
    // and recorder as the tool's own store reads.
    const client = caller.services.createClient({
      delegation: caller.delegation,
      onSettled: caller.services.executionObserver(),
      ...(caller.emitter ? { emitter: caller.emitter } : {}),
      ...identity,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      // Write-service calls stage into this invocation's own stage.
      ...(caller.operations ? { operations: caller.operations } : {}),
      signal:
        combineAbortSignals(signal, invocation.signal) ?? invocation.signal,
      reads: {
        ...(caller.locale !== undefined ? { locale: caller.locale } : {}),
        ...(worldSnapshot ? { world: worldSnapshot } : {}),
        ...(store ? { store } : {}),
        ...(caller.pluginDataVisibility
          ? { visibility: caller.pluginDataVisibility }
          : {}),
        writeBuffer: pending,
      },
    });
    services = Object.freeze({
      discover: (contract: string) => read(() => client.discover(contract)),
      call: (
        request: Parameters<typeof client.call>[0],
        options?: Parameters<typeof client.call>[1],
      ) => read(() => client.call(request, options)),
    });
  }
  const history =
    caller.delegation?.history ??
    new CharacterHistoryReader(store, caller.sessionId);
  const context: ToolExecutionContext = Object.freeze({
    historyFor: (characterId: string, options?: { readonly limit?: number }) =>
      read(() => history.read(characterId, caller.world, options)),
    playerActions: structuredClone(caller.playerActions),
    ...identity,
    ...(caller.locale !== undefined ? { locale: caller.locale } : {}),
    // Frozen by the host and shared across calls; nothing to copy.
    ...(caller.messages !== undefined ? { messages: caller.messages } : {}),
    inputSlots: caller.inputSlots
      ? structuredClone(
          Object.fromEntries(
            Object.entries(caller.inputSlots).filter(
              ([, slot]) =>
                !(
                  slot.cardinality === "one" &&
                  slot.source?.runtimeId === "operations@1"
                ),
            ),
          ),
        )
      : undefined,
    pendingProposals: structuredClone(pending),
    upstreamProposals: structuredClone(caller.upstreamProposals),
    world: worldSnapshot
      ? snapshotWorldModelView(worldSnapshot, assertLive)
      : undefined,
    emittedEventTopics: structuredClone(caller.emittedEventTopics),
    ...(caller.turnNumber !== undefined
      ? { turnNumber: caller.turnNumber }
      : {}),
    ...(caller.logicalTurn !== undefined
      ? { logicalTurn: caller.logicalTurn }
      : {}),
    signal,
    random: createPluginRandom({ ...identity, stream: identity.runtimeId }),
    ...(view ? { store: view } : {}),
    ...(services ? { services } : {}),
  });
  return {
    context,
    assertLive,
    close() {
      closed = true;
      invocation.abort(new Error("Tool invocation has completed"));
    },
    async drain() {
      await Promise.allSettled(pendingReads);
    },
  };
}
