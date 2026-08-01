import { describe, expect, it, vi } from "vitest";
import itemOp from "../rpc/item-op.js";

function makeCtx(existing) {
  const writes = [];
  return {
    ctx: {
      sessionId: "sess-1",
      pluginId: "inventory",
      action: "item-op",
      store: {
        // Full PluginDataRecord shape — the handler spreads the loaded row
        // into its upsert, so the mock must carry the identity fields too.
        getPluginData: vi.fn(async (_s, _p, _ns, key) =>
          existing[key]
            ? {
                id: `row-${key}`,
                sessionId: "sess-1",
                pluginId: "inventory",
                namespace: "items",
                key,
                value: existing[key],
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
              }
            : null,
        ),
        setPluginData: vi.fn(async (record) => {
          writes.push(record);
        }),
      },
    },
    writes,
  };
}

describe("inventory item-op rpc", () => {
  it("equips a backpack item", async () => {
    // Arrange
    const { ctx, writes } = makeCtx({
      "item-1": { name: "钩镰", quantity: 1, equipped: false },
    });

    // Act
    const result = await itemOp({ op: "equip", itemId: "item-1" }, ctx);

    // Assert
    expect(result.ok).toBe(true);
    expect(writes[0].value.equipped).toBe(true);
    expect(writes[0].namespace).toBe("items");
    // Row identity survives the upsert; only updatedAt moves.
    expect(writes[0].id).toBe("row-item-1");
    expect(writes[0].createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(writes[0].updatedAt).not.toBe("2026-08-01T00:00:00.000Z");
  });

  it("unequips an equipped item", async () => {
    // Arrange
    const { ctx, writes } = makeCtx({
      "item-1": { name: "钩镰", quantity: 1, equipped: true },
    });

    // Act
    const result = await itemOp({ op: "unequip", itemId: "item-1" }, ctx);

    // Assert
    expect(result.ok).toBe(true);
    expect(writes[0].value.equipped).toBe(false);
  });

  it("drops an item as the same tombstone shape the tool writes", async () => {
    // Arrange
    const { ctx, writes } = makeCtx({
      "item-1": { name: "火把", quantity: 3, equipped: true },
    });

    // Act
    const result = await itemOp({ op: "drop", itemId: "item-1" }, ctx);

    // Assert
    expect(result.ok).toBe(true);
    expect(writes[0].value).toMatchObject({
      name: "火把",
      quantity: 0,
      equipped: false,
      removed: true,
    });
  });

  it("rejects a missing or already-removed item without writing", async () => {
    // Arrange
    const { ctx, writes } = makeCtx({
      gone: { name: "旧图", quantity: 0, removed: true },
    });

    // Act
    const missing = await itemOp({ op: "equip", itemId: "nope" }, ctx);
    const removed = await itemOp({ op: "drop", itemId: "gone" }, ctx);

    // Assert
    expect(missing.ok).toBe(false);
    expect(removed.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("rejects malformed payloads without touching the store", async () => {
    // Arrange
    const { ctx, writes } = makeCtx({});

    // Act
    const badOp = await itemOp({ op: "use", itemId: "item-1" }, ctx);
    const noId = await itemOp({ op: "equip" }, ctx);
    const junk = await itemOp("garbage", ctx);

    // Assert
    expect(badOp.ok).toBe(false);
    expect(noId.ok).toBe(false);
    expect(junk.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(ctx.store.getPluginData).not.toHaveBeenCalled();
  });
});
