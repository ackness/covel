import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  MAX_PLUGIN_DATA_VALUE_BYTES,
  pluginDataSizeBytes,
} from "@covel/shared";
import { createRpcHandlerStoreView } from "../src/function-runtime/plugin-handler-helpers.js";
import {
  datasetPolicyResolver,
  type DatasetPolicy,
} from "../src/plugin-data-validation.js";
import { createPluginDataCommitHandlers } from "../src/commit/commit-plugin-data.js";

const schema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
};
const ctx = { sessionId: "session", pluginId: "owner" };
const policy: DatasetPolicy = { namespace: "notes", ops: ["set"], schema };

describe("RPC dataset writes", () => {
  it.each([
    [policy, { text: 1 }],
    [{ ...policy, ops: ["inc"] }, { text: "ok" }],
    [{ namespace: "notes", ops: ["set"] }, { text: "ok" }],
    [{ ...policy, schema: { type: "broken" } }, { text: "ok" }],
  ] as const)(
    "refuses invalid writes without changing existing rows",
    async (target, value) => {
      const store = createMemoryStore();
      const seed = {
        id: "stable",
        ...ctx,
        namespace: "notes",
        key: "old",
        value: { text: "before" },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02",
      };
      await store.setPluginData(seed);
      const view = createRpcHandlerStoreView(store, ctx, {
        datasetPolicy: (pluginId, namespace) =>
          pluginId === "owner" && namespace === "notes" ? target : undefined,
      });
      for (const key of ["old", "new"])
        await expect(
          view.setPluginData!({ namespace: "notes", key, value }),
        ).rejects.toThrow(/dataset/);
      expect(
        await store.getPluginData(ctx.sessionId, ctx.pluginId, "notes", "old"),
      ).toEqual(seed);
      expect(
        await store.getPluginData(ctx.sessionId, ctx.pluginId, "notes", "new"),
      ).toBeNull();
      await store.close();
    },
  );

  it("uses the bound owner and the same snapshot for validation and persistence", async () => {
    const store = createMemoryStore();
    const resolver = datasetPolicyResolver(
      [
        { pluginId: "owner", datasets: { notes: policy } },
        {
          pluginId: "forged",
          datasets: { notes: { ...policy, ops: ["set"] } },
        },
      ],
      { owner: { notes: schema }, forged: { notes: {} } },
    );
    const view = createRpcHandlerStoreView(store, ctx, {
      datasetPolicy: resolver,
    });
    const invalid = {
      namespace: "notes",
      key: "key",
      value: { text: 1 },
      sessionId: "forged-session",
      pluginId: "forged",
    };
    const rpcFailure = await view.setPluginData!(invalid).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(rpcFailure instanceof Error))
      throw new Error("Expected dataset refusal");
    const result = await createPluginDataCommitHandlers(store, {
      datasetPolicy: resolver,
    })["plugin.data"]({
      id: "p",
      type: "plugin.data",
      sessionId: ctx.sessionId,
      turnId: "turn",
      source: { pluginId: ctx.pluginId, runtimeId: "owner/run" },
      timestamp: "now",
      payload: invalid,
    });
    expect(result.error).toBe(
      rpcFailure.message.replace("setPluginData:", "plugin.data:"),
    );
    const value = { text: "snapshot" };
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const get = store.getPluginData.bind(store);
    vi.spyOn(store, "getPluginData").mockImplementationOnce(async (...args) => {
      await paused;
      return get(...args);
    });
    const pending = view.setPluginData!({ ...invalid, value });
    value.text = "changed";
    resume();
    await pending;
    const row = await get(ctx.sessionId, ctx.pluginId, "notes", "key");
    expect(row?.value).toEqual({ text: "snapshot" });
    await view.setPluginData!({
      namespace: "notes",
      key: "key",
      value: { text: "replacement" },
    });
    expect(
      await get(ctx.sessionId, ctx.pluginId, "notes", "key"),
    ).toMatchObject({
      id: row?.id,
      createdAt: row?.createdAt,
      value: { text: "replacement" },
    });
    await view.setPluginData!({
      namespace: "unlisted",
      key: "Exact Key",
      value: null,
    });
    expect(
      await get(ctx.sessionId, ctx.pluginId, "unlisted", "Exact Key"),
    ).toBeTruthy();
    await store.close();
  });

  it("counts UTF-8 JSON delimiters at the exact byte limit without truncation", async () => {
    const store = createMemoryStore();
    const view = createRpcHandlerStoreView(store, ctx);
    const exact =
      "界".repeat(Math.floor((MAX_PLUGIN_DATA_VALUE_BYTES - 2) / 3)) + "xx";
    expect(pluginDataSizeBytes(exact)).toBe(MAX_PLUGIN_DATA_VALUE_BYTES);
    await view.setPluginData!({
      namespace: "unlisted",
      key: "size",
      value: exact,
    });
    await expect(
      view.setPluginData!({
        namespace: "unlisted",
        key: "size",
        value: exact + "界",
      }),
    ).rejects.toThrow("limit");
    expect(
      (
        await store.getPluginData(
          ctx.sessionId,
          ctx.pluginId,
          "unlisted",
          "size",
        )
      )?.value,
    ).toBe(exact);
    await store.close();
  });
});
