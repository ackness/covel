import { z } from "zod";
import {
  createMemoryManager,
  trackMemoryBackgroundTask,
  type CoreMemoryConfig,
  type MemoryLLMAdapter,
  type MemoryManager,
  type MemoryUpdater,
  type MemoryUpdaterConfig,
} from "@covel/memory";
import type { DataStore } from "@covel/store/contracts";
import { createInProcessSessionLock } from "../../../lib/session-lock.js";

// Framework bookkeeping, not a concrete plugin identity. Reserved namespaces
// cannot be written through plugin tools, RPCs or plugin-data REST mutations.
const OWNER = "__memory";
const NAMESPACE = "_pending_updates";
const inputSchema = z.object({
  turnId: z.string(),
  traceId: z.string().optional(),
  modelSlot: z.string().optional(),
  narrativeText: z.string(),
  toolCallSummaries: z.array(z.string()).optional(),
  locale: z.string().optional(),
  authoritativeFacts: z
    .object({
      playerCharacter: z
        .object({
          name: z.string(),
          type: z.string(),
          description: z.string().optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      playerFieldLabels: z.record(z.string(), z.string()).optional(),
      lastFormValues: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

type Exclusive = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;

/** Host-owned durable extraction work; provider credentials never enter storage. */
export function createMemoryRecovery(
  store: DataStore,
  coreConfig: CoreMemoryConfig,
  runExclusive?: Exclusive,
) {
  const localLock = createInProcessSessionLock();
  const exclusive: Exclusive =
    runExclusive ?? ((id, task) => localLock.withLock(id, task));
  const commitUpdate: NonNullable<MemoryUpdaterConfig["commitUpdate"]> = async (
    input,
    updates,
  ) => {
    await store.withTransaction(async (tx) => {
      // Bind both block writes and UI mirrors to this transaction. The nested
      // manager batch reuses the existing tx instead of opening another one.
      const manager = createMemoryManager(
        { ...tx, withTransaction: (fn) => fn(tx) },
        coreConfig,
      );
      await manager.updateBlocks(input.sessionId, updates);
      if (input.turnId)
        await tx.deletePluginData(
          input.sessionId,
          OWNER,
          NAMESPACE,
          input.turnId,
        );
    });
  };

  function wrap(
    updater: MemoryUpdater,
    manager: MemoryManager,
    llm: MemoryLLMAdapter,
    modelSlot: () => string,
  ): MemoryUpdater {
    const tracked = <T>(sessionId: string, task: () => Promise<T>) =>
      trackMemoryBackgroundTask(exclusive(sessionId, task), {
        kind: "core-update",
        sessionId,
      });
    const extract: MemoryUpdater["updateAfterTurn"] = async (
      input,
      override,
    ) => {
      const result = await updater.updateAfterTurn(input, override ?? llm);
      if (result.error && !result.persistenceFailed && input.turnId) {
        // A settled provider/parse failure is terminal on both live and
        // recovery paths. Leaving it pending would immediately repeat the
        // same failed request when the next turn waits for memory.
        await store.deletePluginData(
          input.sessionId,
          OWNER,
          NAMESPACE,
          input.turnId,
        );
      }
      return result;
    };
    return {
      async stageAfterTurn(tx, input) {
        if (!input.turnId)
          throw new Error("Durable memory updates require a turnId");
        const now = new Date().toISOString();
        const value = inputSchema.parse({ ...input, modelSlot: modelSlot() });
        await tx.setPluginData({
          id: `memory-work:${input.sessionId}:${input.turnId}`,
          sessionId: input.sessionId,
          pluginId: OWNER,
          namespace: NAMESPACE,
          key: input.turnId,
          value,
          createdAt: now,
          updatedAt: now,
        });
      },
      updateAfterTurn(input, override) {
        return tracked(input.sessionId, () =>
          extract(
            { ...input, modelSlot: input.modelSlot ?? modelSlot() },
            override,
          ),
        );
      },
      awaitPending(sessionId) {
        return tracked(sessionId, async () => {
          await updater.awaitPending(sessionId);
          const rows = [
            ...(await store.listPluginData(sessionId, OWNER, NAMESPACE)),
          ].sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.key.localeCompare(b.key),
          );
          for (const row of rows) {
            const input = inputSchema.parse(row.value);
            if (input.turnId !== row.key)
              throw new Error("Memory recovery scope mismatch");
            const result = await extract(
              {
                ...input,
                sessionId,
                currentBlocks: await manager.loadBlocks(sessionId),
                // Recovery uses this request's slot/adapter, not obsolete credentials.
                modelSlot: modelSlot(),
              },
              llm,
            );
            if (result.persistenceFailed) throw new Error(result.error);
          }
        });
      },
    };
  }
  return { commitUpdate, wrap };
}
