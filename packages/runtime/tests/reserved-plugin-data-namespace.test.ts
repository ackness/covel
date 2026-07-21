/**
 * Framework-owned (`_`-prefixed) plugin-data namespaces must be unreachable
 * from every plugin-controlled write path — the proposal commit boundary, the
 * function-runtime `ctx.pluginData` writer, and the RPC handler store view.
 * Only privileged framework writers (job runner, runtime logger) touch them,
 * and they reach the store directly.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { Proposal } from "@covel/shared";
import {
  createCommitPipeline,
  type KernelStore,
} from "../src/session/session-kernel.js";
import {
  createPluginDataWriter,
  createRpcHandlerStoreView,
} from "../src/function-runtime/plugin-handler-helpers.js";

const SESSION_ID = "sess-reserved-ns";
const PLUGIN_ID = "some-plugin";
const CTX = {
  sessionId: SESSION_ID,
  pluginId: PLUGIN_ID,
  runtimeId: `${PLUGIN_ID}/runner`,
  turnId: "turn-reserved-ns",
};

function makePluginDataProposal(namespace: string): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data",
    source: { pluginId: PLUGIN_ID, runtimeId: CTX.runtimeId },
    turnId: CTX.turnId,
    sessionId: SESSION_ID,
    payload: { namespace, key: "job-1", value: { status: "completed" } },
    timestamp: new Date().toISOString(),
  };
}

describe("reserved plugin-data namespaces", () => {
  it("rejects `_`-prefixed namespaces on every plugin-facing write path", async () => {
    const store = createMemoryStore();
    const pipeline = createCommitPipeline(store as unknown as KernelStore);

    const single = await pipeline.commit(makePluginDataProposal("_jobs"));
    expect(single.committed).toBe(false);
    expect(single.error).toContain("reserved");

    const batch = await pipeline.commit({
      ...makePluginDataProposal("_jobs"),
      type: "plugin.data.batch",
      payload: {
        items: [{ namespace: "_jobs", key: "job-1", value: { status: "ok" } }],
      },
    } as Proposal);
    expect(batch.committed).toBe(false);
    expect(batch.error).toContain("reserved");

    const writer = createPluginDataWriter(store, CTX);
    await expect(
      writer.set("_jobs", "job-1", { status: "ok" }),
    ).rejects.toThrow(/reserved/);
    await expect(writer.delete("_logs", "entry-1")).rejects.toThrow(/reserved/);

    const rpcStore = createRpcHandlerStoreView(store, CTX);
    await expect(
      rpcStore.setPluginData({
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        namespace: "_jobs",
        key: "job-1",
        value: { status: "ok" },
      }),
    ).rejects.toThrow(/reserved/);

    // Nothing leaked into the store on any path.
    expect(
      await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs"),
    ).toHaveLength(0);
  });
});
