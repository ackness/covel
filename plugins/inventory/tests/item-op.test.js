import { describe, expect, it, vi } from "vitest";
import {
  loadPluginMessages,
  makeManualFunctionContext,
} from "@covel/plugin-test-utils";
import handler from "../runtimes/item-op/handler.js";

const ITEM = { name: "钩镰", quantity: 1, equipped: false };

function makeCtx(existing = {}, manualPayload = {}) {
  const writes = [];
  const pluginData = {
    get: vi.fn(async (_ns, key) => existing[key] ?? null),
    set: vi.fn(async (namespace, key, value) => {
      writes.push({ namespace, key, value });
    }),
  };
  return {
    ctx: {
      ...makeManualFunctionContext({
        pluginId: "inventory",
        runtimeId: "inventory/item-op",
        manualPayload,
      }),
      pluginData,
    },
    pluginData,
    writes,
  };
}

describe("inventory item-op runtime", () => {
  it.each([
    [
      "en-US",
      "That item is no longer in your bag.",
      "That bag action is not supported.",
    ],
    ["zh-CN", "这件物品已经不在你的背包里了。", "不支持这项背包操作。"],
    [
      "ru-RU",
      "Этого предмета больше нет в вашей сумке.",
      "Это действие с сумкой не поддерживается.",
    ],
  ])(
    "localizes both failures in %s without exposing the item id",
    async (locale, missing, unsupported) => {
      const { ctx, pluginData } = makeCtx();
      const localized = {
        ...ctx,
        locale,
        messages: await loadPluginMessages(
          new URL("..", import.meta.url),
          locale,
        ),
      };
      for (const [op, error] of [
        ["equip", missing],
        ["use", unsupported],
      ]) {
        const result = await handler({
          ...localized,
          manualPayload: { op, itemId: "private-item-id" },
        });
        expect(result).toEqual({ outcome: "failed", error });
        expect(result.error).not.toContain("private-item-id");
      }
      expect(pluginData.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["equip", { ...ITEM }, true],
    ["unequip", { ...ITEM, equipped: true }, false],
  ])("%s toggles the equipped flag", async (op, item, equipped) => {
    // Arrange
    const { ctx, writes } = makeCtx(
      { "item-1": item },
      { op, itemId: "item-1" },
    );

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result).toMatchObject({
      outcome: "success",
      value: { op, item: { ...item, equipped } },
    });
    expect(writes).toEqual([
      {
        namespace: "items",
        key: "item-1",
        value: expect.objectContaining({ equipped }),
      },
    ]);
  });

  it("stamps updatedAt so the summary treats the change as recent", async () => {
    const { ctx, writes } = makeCtx(
      {
        "item-1": {
          ...ITEM,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      { op: "equip", itemId: "item-1" },
    );
    await handler(ctx);
    expect(writes[0].value.updatedAt > "2026-08-01T00:00:00.000Z").toBe(true);
  });

  it("drops an item as the same tombstone shape the tool writes", async () => {
    // Arrange
    const item = { name: "火把", quantity: 3, equipped: true };
    const { ctx, writes } = makeCtx(
      { "item-1": item },
      { op: "drop", itemId: "item-1" },
    );

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.outcome).toBe("success");
    expect(writes[0].value).toMatchObject({
      name: "火把",
      quantity: 0,
      equipped: false,
      removed: true,
    });
    expect(result.value.item).toEqual(writes[0].value);
  });

  it.each([
    ["missing", null],
    ["removed", { name: "旧图", quantity: 0, removed: true }],
    ["non-object", "not an object"],
  ])("rejects a %s item without writing", async (_label, item) => {
    // Arrange
    const { ctx, pluginData } = makeCtx(
      { "item-1": item },
      { op: "equip", itemId: "item-1" },
    );

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result).toEqual({
      outcome: "failed",
      error: "That item is no longer in your bag.",
    });
    expect(pluginData.get).toHaveBeenCalledWith("items", "item-1");
    expect(pluginData.set).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsupported op", { op: "use", itemId: "item-1" }],
    ["a missing itemId", { op: "equip" }],
    ["a non-string itemId", { op: "equip", itemId: 7 }],
    ["a non-object payload", "garbage"],
  ])("rejects %s without reading or writing", async (_label, payload) => {
    // Arrange
    const { ctx, pluginData } = makeCtx({}, payload);

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result).toEqual({
      outcome: "failed",
      error: "That bag action is not supported.",
    });
    expect(pluginData.get).not.toHaveBeenCalled();
    expect(pluginData.set).not.toHaveBeenCalled();
  });
});
