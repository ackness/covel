import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "@covel/tools";
import { createRootOperationStage } from "@covel/runtime";
import {
  callTestService,
  createPluginTestStore,
  makeTestServiceRegistry,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";

const definitions = [];
register({
  toolkit: { z },
  registerService: (definition) => definitions.push(definition),
  registerRpc: () => {},
  provideExtension: () => {},
});
const caller = {
  pluginId: "narrator",
  sessionId: "session",
  turnId: "turn",
  runtimeId: "narrator",
};
const stores = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
});
async function fixture(items = []) {
  const store = await createPluginTestStore({
    sessionId: caller.sessionId,
    pluginId: "inventory",
  });
  stores.push(store);
  for (const [index, item] of items.entries()) {
    await store.setPluginData({
      id: `row-${index}`,
      sessionId: caller.sessionId,
      pluginId: "inventory",
      namespace: "items",
      key: item.id,
      value: { tags: [], equipped: false, ...item },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  }
  const registry = makeTestServiceRegistry({
    activePluginIds: [caller.pluginId],
    services: { inventory: definitions },
  });
  const request = (name, input) => ({
    pluginId: "inventory",
    name,
    contract: `inventory.${name}@1`,
    input,
  });
  const call = (name, input) =>
    callTestService({ registry, caller, request: request(name, input), store });
  return { store, registry, request, call };
}
const gold = {
  id: "item-gold-private",
  name: "Gold",
  quantity: 12,
  tags: ["currency"],
};
const noIds = (value) => {
  expect(JSON.stringify(value)).not.toMatch(/"(?:id|itemId)"|item-/);
};

describe("inventory bag service", () => {
  it("hides tombstones and empty rows, sorts equipped first then names, and omits private IDs", async () => {
    const { call } = await fixture([
      gold,
      { id: "item-z", name: "Zither", quantity: 1, equipped: true },
      { id: "item-a", name: "Apple", quantity: 2 },
      { id: "item-x", name: "Lost", quantity: 4, removed: true },
      { id: "item-zero", name: "Empty", quantity: 0 },
      { id: "item-b", name: "Boots", quantity: 1, equipped: true },
    ]);
    const { output, operations } = await call("bag", {});
    expect(output.items.map(({ name }) => name)).toEqual([
      "Boots",
      "Zither",
      "Apple",
      "Gold",
    ]);
    expect(output.total).toBe(4);
    expect(operations).toEqual([]);
    noIds(output);
  });
  it("matches names and tags case-insensitively and counts all matches before limiting", async () => {
    const { call } = await fixture([
      gold,
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `item-${index}`,
        name: `Supplies ${String(index).padStart(2, "0")}`,
        quantity: 1,
        tags: ["Travel"],
      })),
    ]);
    expect((await call("bag", { query: "gOL" })).output).toMatchObject({
      total: 1,
      items: [{ name: "Gold" }],
    });
    const { output } = await call("bag", { query: "TRAV" });
    expect(output.items).toHaveLength(50);
    expect(output.total).toBe(55);
    expect((await call("bag", {})).output.total).toBe(56);
    noIds(output);
  });
});

describe("inventory change service", () => {
  it("stages payment, goods and the turn toast together without committing or returning IDs", async () => {
    const { call, store } = await fixture([gold]);
    const { output, operations } = await call("change", {
      changes: [
        { op: "remove", item: "Gold", quantity: 10 },
        { op: "add", item: " Sword " },
      ],
    });
    noIds(output);
    expect(output.results).toEqual([
      { op: "remove", item: "Gold", status: "updated", quantity: 2 },
      { op: "add", item: "Sword", status: "created", quantity: 1 },
    ]);
    expect(operations).toHaveLength(1);
    const [payment, sword, message] = operations[0].writes;
    expect(payment).toMatchObject({
      type: "plugin.data.update",
      payload: {
        namespace: "items",
        key: gold.id,
        ops: [
          { op: "inc", path: "/quantity", by: -10, min: 0 },
          { op: "merge" },
        ],
      },
    });
    expect(payment.payload.ops[0]).not.toHaveProperty("onBound");
    expect(sword).toMatchObject({
      type: "plugin.data.update",
      payload: {
        namespace: "items",
        ops: [{ op: "set", value: { name: "Sword", quantity: 1 } }],
      },
    });
    expect(message).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "message",
        key: caller.turnId,
        value: {
          turnId: caller.turnId,
          changes: [
            { text: "− Gold ×10", seq: 0 },
            { text: "+ Sword ×1", seq: 1 },
          ],
        },
      },
    });
    expect(
      (
        await store.getPluginData(
          caller.sessionId,
          "inventory",
          "items",
          gold.id,
        )
      ).value.quantity,
    ).toBe(12);
    expect(
      await store.listPluginData(caller.sessionId, "inventory", "message"),
    ).toEqual([]);
  });
  it.each([
    [
      [
        { op: "add", item: "Sword" },
        { op: "remove", item: "Gold", quantity: 15 },
      ],
      "Gold: holds 12, needs 15",
    ],
    [[{ op: "equip", item: "Sword" }], "Sword is not in the bag"],
    [[{ op: "unequip", item: "Sword" }], "Sword is not in the bag"],
    [[{ op: "remove", item: "Sword" }], "Sword: holds 0, needs 1"],
    [
      [
        { op: "remove", item: "Gold", quantity: 7 },
        { op: "remove", item: "Gold", quantity: 6 },
      ],
      "Gold: holds 5, needs 6",
    ],
  ])(
    "refuses an invalid exchange before staging any part: %j",
    async (changes, message) => {
      const { call, registry, request, store } = await fixture([gold]);
      await expect(call("change", { changes })).rejects.toMatchObject({
        code: "refused",
        message,
      });
      const root = createRootOperationStage({
        caller,
        sessionId: caller.sessionId,
        turnId: caller.turnId,
      });
      const client = registry.createClient({
        ...caller,
        signal: new AbortController().signal,
        reads: { store },
        operations: root,
      });
      await expect(
        client.call(request("change", { changes })),
      ).rejects.toMatchObject({ code: "refused", message });
      const carrier = {};
      root.attachTo(carrier, true);
      expect(carrier.operations ?? []).toEqual([]);
      expect(carrier.operationWrites ?? {}).toEqual({});
    },
  );
  it("sees earlier calls in the same stage, stacks goods and appends messages", async () => {
    const { registry, request, store } = await fixture();
    const stage = createRootOperationStage({
      caller,
      sessionId: caller.sessionId,
      turnId: caller.turnId,
    });
    const client = registry.createClient({
      ...caller,
      signal: new AbortController().signal,
      reads: { store },
      operations: stage,
    });
    const input = { changes: [{ op: "add", item: "Sword" }] };
    expect(await client.call(request("change", input))).toMatchObject({
      results: [{ quantity: 1 }],
    });
    expect(await client.call(request("change", input))).toMatchObject({
      results: [{ quantity: 2, status: "updated" }],
    });
    expect(await client.call(request("bag", {}))).toMatchObject({
      total: 1,
      items: [{ name: "Sword", quantity: 2 }],
    });
    const carrier = {};
    stage.attachTo(carrier, true);
    expect(carrier.operations).toHaveLength(2);
    const second = carrier.operationWrites[carrier.operations[1].id];
    expect(second[0].payload.ops[0]).toEqual({
      op: "inc",
      path: "/quantity",
      by: 1,
    });
    expect(second.at(-1).payload.value.changes.map(({ text }) => text)).toEqual(
      ["+ Sword ×1", "+ Sword ×1"],
    );
  });
  it("plans gains, equipment and consumption sequentially and keeps the existing turn message", async () => {
    const { call, store } = await fixture();
    await store.setPluginData({
      id: "previous-message",
      sessionId: caller.sessionId,
      pluginId: "inventory",
      namespace: "message",
      key: caller.turnId,
      value: {
        turnId: caller.turnId,
        marker: "keep",
        changes: [{ text: "+ Rope ×1", seq: 0 }],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const { output, operations } = await call("change", {
      changes: [
        {
          op: "add",
          item: "Sword",
          description: "A plain blade",
          tags: ["weapon"],
        },
        { op: "equip", item: "sword" },
        { op: "unequip", item: "SWORD" },
        { op: "remove", item: "Sword" },
      ],
    });
    expect(output.results.map(({ status }) => status)).toEqual([
      "created",
      "updated",
      "updated",
      "removed",
    ]);
    noIds(output);
    const [item, message] = operations[0].writes;
    expect(item.payload.ops.map(({ op }) => op)).toEqual([
      "set",
      "merge",
      "merge",
      "inc",
      "merge",
    ]);
    expect(item.payload.ops[0].value).toMatchObject({
      description: "A plain blade",
      tags: ["weapon"],
    });
    expect(item.payload.ops[3]).toEqual({
      op: "inc",
      path: "/quantity",
      by: -1,
      min: 0,
    });
    expect(message.payload.value).toMatchObject({
      marker: "keep",
      changes: [
        { text: "+ Rope ×1", seq: 0 },
        { text: "+ Sword ×1", seq: 1 },
        { text: "Sword", seq: 2 },
        { text: "Sword", seq: 3 },
        { text: "− Sword ×1", seq: 4 },
      ],
    });
  });

  it("refuses equipment or removal of empty and tombstoned rows", async () => {
    const { call } = await fixture([
      { id: "item-empty", name: "Empty", quantity: 0 },
      { id: "item-removed", name: "Lost", quantity: 2, removed: true },
    ]);
    for (const item of ["Empty", "Lost"]) {
      for (const op of ["remove", "equip", "unequip"]) {
        await expect(
          call("change", { changes: [{ op, item }] }),
        ).rejects.toMatchObject({ code: "refused" });
      }
    }
  });

  it("revives a removed item under its original ID", async () => {
    const { call } = await fixture([
      { id: "item-old-sword", name: "Sword", quantity: 0, removed: true },
    ]);
    const { output, operations } = await call("change", {
      changes: [{ op: "add", item: "sWoRd", quantity: 2 }],
    });
    expect(output.results).toEqual([
      { op: "add", item: "Sword", status: "created", quantity: 2 },
    ]);
    noIds(output);
    expect(operations[0].writes[0].payload).toMatchObject({
      key: "item-old-sword",
      ops: [
        { op: "inc", path: "/quantity", by: 2 },
        { op: "merge", value: { removed: null, equipped: false } },
      ],
    });
  });
  it.each(
    [
      [],
      Array.from({ length: 9 }, () => ({ op: "add", item: "Sword" })),
      [{ op: "add", item: " " }],
      [{ op: "add", item: "x".repeat(81) }],
      [{ op: "remove", item: "Gold", quantity: 0 }],
      [{ op: "remove", item: "Gold", quantity: 1000 }],
      [{ op: "add", item: "Sword", quantity: 1.5 }],
      [{ op: "equip", item: "Sword", quantity: 1 }],
      [{ op: "remove", item: "Gold", description: "Payment" }],
      [{ op: "add", item: "Sword", description: "x".repeat(201) }],
      [{ op: "add", item: "Sword", tags: Array(6).fill("tag") }],
    ].map((changes) => [changes]),
  )("rejects changes outside the service contract: %j", async (changes) => {
    const { call } = await fixture([gold]);
    await expect(call("change", { changes })).rejects.toThrow();
  });
});
