import { describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import {
  callTestService,
  createPluginTestStore,
  executeToolAndCommit,
  makeTestServiceRegistry,
} from "../src/index.js";

const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "notes",
  runtimeId: "notes/write",
};

describe("test service registry", () => {
  it("gives a tool context.services that calls the registered provider", async () => {
    const store = await createPluginTestStore(context);
    const services = makeTestServiceRegistry({
      sessionId: context.sessionId,
      activePluginIds: ["notes"],
      services: {
        inventory: [
          {
            name: "items",
            contract: "inventory.items@1",
            input: z.object({ bag: z.string() }),
            output: z.array(z.string()),
            handler: ({ bag }: { bag: string }) => [`${bag} sword`],
          },
        ],
      },
    });
    const count = tool({
      name: "count",
      description: "Count the items in a bag",
      annotations: { readOnly: true },
      parameters: z.object({ bag: z.string() }),
      async execute({ bag }, ctx) {
        const items = (await ctx.services!.call({
          pluginId: "inventory",
          name: "items",
          contract: "inventory.items@1",
          input: { bag },
        })) as string[];
        return { count: items.length, first: items[0] };
      },
    });
    try {
      await expect(
        executeToolAndCommit(
          count,
          { bag: "leather" },
          { ...context, services },
          store,
        ),
      ).resolves.toEqual({ count: 1, first: "leather sword" });
    } finally {
      await store.close();
    }
  });

  it("calls a write service without a turn and returns what it staged", async () => {
    const store = await createPluginTestStore({
      sessionId: context.sessionId,
      pluginId: "bank",
    });
    await store.setPluginData({
      id: "row",
      sessionId: context.sessionId,
      pluginId: "bank",
      namespace: "purse",
      key: "coins",
      value: { amount: 10 },
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    });
    const registry = makeTestServiceRegistry({
      activePluginIds: ["notes"],
      services: {
        bank: [
          {
            name: "pay",
            contract: "bank.pay@1",
            access: "write",
            input: z.object({ amount: z.number() }),
            output: z.object({ left: z.number() }),
            handler: async (
              { amount }: { amount: number },
              ctx,
            ): Promise<{ left: number }> => {
              await ctx.pluginData.update("purse", "coins", [
                { op: "inc", path: "/amount", by: -amount, min: 0 },
              ]);
              const purse = (await ctx.pluginData.get("purse", "coins")) as {
                amount: number;
              };
              return { left: purse.amount };
            },
          },
        ],
      },
    });
    try {
      const { output, operations } = await callTestService({
        registry,
        caller: { pluginId: "notes", sessionId: context.sessionId },
        request: {
          pluginId: "bank",
          name: "pay",
          contract: "bank.pay@1",
          input: { amount: 3 },
        },
        store,
      });
      expect(output).toEqual({ left: 7 });
      expect(operations).toHaveLength(1);
      expect(operations[0]!.record).toMatchObject({
        contract: "bank.pay@1",
        providerPluginId: "bank",
        status: "staged",
        invokedBy: { pluginId: "notes" },
      });
      expect(operations[0]!.writes).toMatchObject([
        {
          type: "plugin.data.update",
          source: { pluginId: "bank", runtimeId: "service:pay" },
        },
      ]);
      // Nothing commits.
      expect(
        (await store.getPluginData(context.sessionId, "bank", "purse", "coins"))
          ?.value,
      ).toEqual({ amount: 10 });
    } finally {
      await store.close();
    }
  });
});
