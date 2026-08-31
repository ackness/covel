import { describe, expect, it, vi } from "vitest";
import { shortIdBatch, tool, z } from "@covel/tools";
import openBag from "../rpc/open-bag.js";
import registerInventory from "../server/index.js";

function makeCtx(rows, locale = "zh-CN") {
  return {
    sessionId: "sess-1",
    pluginId: "inventory",
    action: "open-bag",
    locale,
    store: {
      listPluginData: vi.fn(async () => rows),
    },
  };
}

describe("inventory open-bag command", () => {
  it("registers open-bag without replacing the existing item-op action", () => {
    const registerRpc = vi.fn();
    const registerTool = vi.fn();
    registerInventory({
      toolkit: { shortIdBatch, tool, z, store: {} },
      registerRpc,
      registerTool,
    });

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerRpc.mock.calls.map(([action]) => action)).toEqual([
      "item-op",
      "open-bag",
    ]);
    expect(registerRpc).toHaveBeenCalledWith(
      "open-bag",
      openBag,
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("counts non-removed item entries and opens the inventory panel", async () => {
    const ctx = makeCtx([
      { value: { name: "火把", quantity: 2 } },
      { value: { name: "旧地图", quantity: 0, removed: true } },
      { value: { name: "短剑", quantity: 1, equipped: true } },
      { value: null },
    ]);

    const result = await openBag(
      { command: "bag", raw: "/bag", argv: [], args: {} },
      ctx,
    );

    expect(ctx.store.listPluginData).toHaveBeenCalledWith(
      "sess-1",
      "inventory",
      "items",
    );
    expect(result).toEqual({
      ok: true,
      message: "行囊中有 2 项物品。",
      data: { itemCount: 2 },
      clientAction: {
        type: "open-plugin-panel",
        panelId: "inventory",
      },
    });
  });

  it("localizes the empty bag message", async () => {
    const result = await openBag({}, makeCtx([], "en-US"));

    expect(result.message).toBe("Your bag contains 0 item entries.");
    expect(result.data.itemCount).toBe(0);
  });
});
