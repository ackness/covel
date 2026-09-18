import type { MemoryUpdateInput, MemoryUpdateResult } from "@covel/memory";
import { createTurnEmitter } from "@covel/runtime";
import type { DataStore } from "@covel/store";

/** Keep extraction failures visible across reconnects without polluting prompt blocks. */
export async function observeMemoryUpdate(
  store: DataStore,
  panelPluginId: string | undefined,
  input: MemoryUpdateInput,
  result: MemoryUpdateResult,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const status = {
    status: result.error ? "failed" : "succeeded",
    turnId: input.turnId,
    slot: input.modelSlot,
    ...result,
    updatedAt,
  };
  if (input.turnId) {
    await createTurnEmitter({
      store,
      sessionId: input.sessionId,
      turnId: input.turnId,
      traceId: input.traceId,
    }).emit("memory.updated", status);
  }
  if (panelPluginId && (await store.getSession(input.sessionId))) {
    await store.setPluginData({
      id: `memory-status:${input.sessionId}`,
      sessionId: input.sessionId,
      pluginId: panelPluginId,
      namespace: "_memory",
      key: "update",
      value: status,
      createdAt: updatedAt,
      updatedAt,
    });
  }
}
