import { describe, expect, it } from "vitest";
import handler from "../runtimes/intake/handler.js";

function makeCtx(items) {
  const writes = [];
  return {
    writes,
    ctx: {
      inputs: {
        plans: { cardinality: "all", items },
        dimensions: { value: { location: { value: "pier", version: 1 } } },
      },
      store: { getSession: async () => ({ completedPlayerTurns: 2 }) },
      pluginData: {
        list: async () => [],
        set: async (namespace, key, value) => {
          writes.push({ namespace, key, value });
        },
      },
    },
  };
}

describe("intake handler", () => {
  it("writes accepted plans to the hidden planned bucket", async () => {
    const { ctx, writes } = makeCtx([
      {
        value: {
          events: [
            {
              id: "tide-bell",
              when: { dimension: "location", equals: "pier" },
              payload: "The drowned bell rings once.",
            },
            {
              id: "nowhere",
              when: { dimension: "weather", equals: "rain" },
              payload: "Never stored.",
            },
          ],
        },
        source: { pluginId: "story-plotter", runtimeId: "story-plotter/plot" },
      },
    ]);
    const result = await handler(ctx);
    expect(result.value).toEqual({
      accepted: ["tide-bell"],
      retired: [],
      rejected: [
        {
          id: "nowhere",
          origin: "story-plotter/plot",
          reason: "unknown dimension: weather",
        },
      ],
    });
    expect(writes.map((write) => [write.namespace, write.key])).toEqual([
      ["_hidden.planned", "tide-bell"],
    ]);
    expect(writes[0].value.plannedTurn).toBe(3);
  });

  it("does nothing without plans", async () => {
    const { ctx, writes } = makeCtx([]);
    expect((await handler(ctx)).value.accepted).toEqual([]);
    expect(writes).toEqual([]);
  });
});
