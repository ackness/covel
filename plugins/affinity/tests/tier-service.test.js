import { afterEach, describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import { shortIdBatch } from "@covel/plugin-handlers-utils";
import {
  callTestService,
  createPluginTestStore,
  makeTestServiceRegistry,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";

const definitions = [];
register({
  toolkit: { tool, z, shortIdBatch },
  registerTool() {},
  registerService: (definition) => definitions.push(definition),
  provideExtension() {},
});
const caller = {
  pluginId: "dice-check",
  sessionId: "session",
  turnId: "turn",
  runtimeId: "dice-check/roller",
};
const stores = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture(records) {
  const store = await createPluginTestStore({
    sessionId: caller.sessionId,
    pluginId: "affinity",
  });
  stores.push(store);
  for (const [index, value] of records.entries())
    await store.setPluginData({
      id: `row-${index}`,
      sessionId: caller.sessionId,
      pluginId: "affinity",
      namespace: "affinity",
      key: value.id,
      value,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  const registry = makeTestServiceRegistry({
    activePluginIds: [caller.pluginId],
    services: { affinity: definitions },
  });
  return (input) =>
    callTestService({
      registry,
      caller,
      store,
      request: { contract: "affinity.tier@1", input },
    });
}

const records = [
  { id: "graham-pike", name: "Graham Pike", score: -35 },
  { id: "dara-quinn", name: "Dara Quinn", score: 64 },
  { id: "broken", name: "Nobody", score: "high" },
];

describe("affinity.tier@1", () => {
  it("lists every NPC's score and tier by name, without record ids, and writes nothing", async () => {
    const call = await fixture(records);
    const { output, operations } = await call({});
    expect(output).toEqual({
      tiers: ["hostile", "cold", "neutral", "friendly", "close", "devoted"],
      characters: [
        { name: "Dara Quinn", score: 64, tier: "close", label: "Close" },
        { name: "Graham Pike", score: -35, tier: "cold", label: "Cold" },
      ],
    });
    expect(JSON.stringify(output)).not.toMatch(/graham-pike|dara-quinn/);
    expect(operations).toEqual([]);
  });

  it("narrows to one character by name, case-insensitively", async () => {
    const call = await fixture(records);
    expect((await call({ name: "graham pike" })).output.characters).toEqual([
      { name: "Graham Pike", score: -35, tier: "cold", label: "Cold" },
    ]);
    expect((await call({ name: "Someone Else" })).output.characters).toEqual(
      [],
    );
  });

  it("refuses an input that is not the contract's", async () => {
    const call = await fixture(records);
    await expect(call({ name: "x".repeat(81) })).rejects.toThrow();
    await expect(call({ name: 5 })).rejects.toThrow();
  });
});
