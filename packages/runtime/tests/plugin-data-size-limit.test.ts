/**
 * One plugin-data value has a size limit on every plugin-facing write path.
 * The error names the plugin, the namespace/key and the limit, and nothing is
 * stored: a value is never truncated.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { Proposal } from "@covel/shared";
import {
  createCommitPipeline,
  type KernelStore,
} from "../src/session/session-kernel.js";
import {
  createPluginDataWriter,
  createRpcHandlerStoreView,
} from "../src/function-runtime/plugin-handler-helpers.js";
import { MAX_PLUGIN_DATA_VALUE_BYTES } from "../src/commit/plugin-data-limits.js";

const SESSION_ID = "sess-size-limit";
const PLUGIN_ID = "bulky-plugin";
const CTX = {
  sessionId: SESSION_ID,
  pluginId: PLUGIN_ID,
  runtimeId: `${PLUGIN_ID}/runner`,
  turnId: "turn-size-limit",
};

const small = { text: "x".repeat(1000) };
const huge = { text: "x".repeat(MAX_PLUGIN_DATA_VALUE_BYTES) };

function proposal(
  type: "plugin.data" | "plugin.data.batch",
  value: unknown,
): Proposal {
  const payload =
    type === "plugin.data"
      ? { namespace: "notes", key: "log", value }
      : { items: [{ namespace: "notes", key: "log", value }] };
  return {
    id: crypto.randomUUID(),
    type,
    source: { pluginId: PLUGIN_ID, runtimeId: CTX.runtimeId },
    turnId: CTX.turnId,
    sessionId: SESSION_ID,
    payload,
    timestamp: new Date().toISOString(),
  } as Proposal;
}

describe("plugin-data value size limit", () => {
  it("rejects an oversized value at the commit boundary and stores nothing", async () => {
    const store = createMemoryStore();
    const pipeline = createCommitPipeline(store as unknown as KernelStore);

    for (const type of ["plugin.data", "plugin.data.batch"] as const) {
      const ok = await pipeline.commit(proposal(type, small));
      expect(ok.committed).toBe(true);

      const rejected = await pipeline.commit(proposal(type, huge));
      expect(rejected.committed).toBe(false);
      expect(rejected.error).toContain(`plugin "${PLUGIN_ID}"`);
      expect(rejected.error).toContain("notes/log");
      expect(rejected.error).toContain(String(MAX_PLUGIN_DATA_VALUE_BYTES));
    }

    // The earlier small value is still what the store holds.
    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual(small);
  });

  it("throws the same error from ctx.pluginData and the RPC store view", async () => {
    const store = createMemoryStore();

    const writer = createPluginDataWriter(store, CTX);
    await expect(writer.set("notes", "log", huge)).rejects.toThrow(
      /bulky-plugin.*notes\/log.*limit/,
    );
    await writer.set("notes", "log", small);

    const rpcStore = createRpcHandlerStoreView(store, CTX);
    await expect(
      rpcStore.setPluginData!({
        namespace: "notes",
        key: "log",
        value: huge,
      }),
    ).rejects.toThrow(/bulky-plugin.*notes\/log.*limit/);

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "notes");
    expect(rows.map((r) => r.value)).toEqual([small]);
  });
});
