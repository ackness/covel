import { describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import {
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
});
