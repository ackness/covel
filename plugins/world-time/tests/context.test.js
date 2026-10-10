import { getPendingProposals } from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";

import handler from "../runtimes/context/handler.js";

function ctx(rows, locale = "en-US") {
  return {
    sessionId: "s",
    turnId: "t-2",
    pluginId: "world-time",
    runtimeId: "world-time/context",
    locale,
    recursionDepth: 0,
    store: {
      getPluginData: async (namespace, key) =>
        rows[`${namespace}/${key}`]
          ? { value: rows[`${namespace}/${key}`] }
          : null,
    },
  };
}

describe("world-time context runtime", () => {
  it("writes the clock on the first turn and not again while nothing changed", async () => {
    const first = await handler(ctx({}));
    const [proposal] = getPendingProposals(first);
    expect(proposal.payload).toMatchObject({
      namespace: "clock",
      key: "current",
    });

    // The committed record, as the store returns it on the next turn.
    const stored = JSON.parse(JSON.stringify(proposal.payload.value));
    const second = await handler(ctx({ "clock/current": stored }));
    expect(getPendingProposals(second)).toEqual([]);
    expect(second.value.tick).toBe(stored.tick);
  });

  it("writes the clock again when the session language changes its text", async () => {
    const first = await handler(ctx({}));
    const stored = JSON.parse(
      JSON.stringify(getPendingProposals(first)[0].payload.value),
    );
    const other = await handler(ctx({ "clock/current": stored }, "zh-CN"));
    expect(getPendingProposals(other)).toHaveLength(1);
  });
});
