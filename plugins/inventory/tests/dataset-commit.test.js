import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateOutput } from "@covel/tools";
import path from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import { executeTurn, commitExecution } from "@covel/runtime";
import {
  applyDataOps,
  getPendingProposals,
  getToolContent,
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";

const schema = JSON.parse(
  readFileSync(
    new URL("../schemas/items.schema.json", import.meta.url),
    "utf8",
  ),
);
const examples = JSON.parse(
  readFileSync(new URL("../examples/items.json", import.meta.url), "utf8"),
);

const now = "2026-09-18T00:00:00Z";
const sessionId = "inventory-dataset";
const initialItem = {
  id: "torch",
  name: "Torch",
  quantity: 2,
  tags: ["tool"],
  equipped: false,
};
const worldIRSchema = JSON.parse(
  readFileSync(
    new URL("../../world-ir/schemas/world-ir.schema.json", import.meta.url),
    "utf8",
  ),
);
const worldIR = {
  schemaVersion: 1,
  entities: [
    { id: "player", type: "character", name: "Ren" },
    { id: "torch", type: "item", name: "Torch" },
    { id: "rope", type: "item", name: "Rope" },
  ],
  relations: [],
  statements: [],
  events: [
    {
      id: "gain-torch",
      type: "inventory_change",
      attributes: {
        item: "torch",
        holder: "player",
        operation: "gain",
        quantity: 3,
      },
    },
    {
      id: "lose-torch",
      type: "inventory_change",
      attributes: {
        item: "torch",
        holder: "player",
        operation: "lose",
        quantity: 1,
      },
    },
    {
      id: "equip-torch",
      type: "inventory_change",
      attributes: { item: "torch", holder: "player", operation: "equip" },
    },
    {
      id: "gain-rope",
      type: "inventory_change",
      attributes: { item: "rope", holder: "player", operation: "gain" },
    },
  ],
};

async function fixture(invalidWrite) {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    locale: "en",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    activePlugins: ["inventory", "story", "facts"],
    createdAt: now,
    updatedAt: now,
  });
  await store.upsertCharacter({
    id: "player",
    sessionId,
    name: "Ren",
    type: "player",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await store.setPluginData({
    id: "seed",
    sessionId,
    pluginId: "inventory",
    namespace: "items",
    key: "torch",
    value: initialItem,
    createdAt: now,
    updatedAt: now,
  });
  const discovery = (
    await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
  ).find((entry) => entry.id === "inventory");
  const parsed = (await loadPluginManifest(discovery)).find(
    (entry) => entry.manifest.name === "inventory/ledger",
  );
  const ledger = await loadRuntime(
    discovery,
    parsed.manifest.name,
    undefined,
    undefined,
    { "world-ir@1": worldIRSchema },
  );
  const recorded = [];
  let rejected;
  const handler = ledger.handler;
  const loaded = new Map([
    [
      ledger.manifest.name,
      {
        ...ledger,
        handler: async (ctx) => {
          const result = await handler(ctx);
          recorded.push(result);
          if (!invalidWrite) return result;
          rejected = makeProposal(ctx, now, "plugin.data.update", {
            namespace: "items",
            key: "torch",
            ops: [invalidWrite],
          });
          return withPendingProposals(getToolContent(result), [
            ...getPendingProposals(result),
            rejected,
          ]);
        },
      },
    ],
  ]);
  const story = {
    name: "story",
    pluginId: "story",
    stage: "narrative",
    runtimeType: "function",
    outputKind: "story",
    outputContract: "narrative-engine@2",
    trigger: { type: "auto" },
  };
  loaded.set(story.name, {
    manifest: story,
    promptTemplate: "",
    handler: async (ctx) =>
      withPendingProposals(
        {
          outcome: "success",
          value: {
            narrativeOutput: "Ren gathers supplies and equips a torch.",
          },
        },
        [
          makeProposal(ctx, now, "plugin.data", {
            namespace: "saved",
            key: ctx.turnId,
            value: "Story preserved",
          }),
        ],
      ),
  });
  const facts = {
    name: "facts",
    pluginId: "facts",
    stage: "post-turn",
    runtimeType: "function",
    outputKind: "system",
    outputContract: "world-ir-provider@1",
    trigger: { type: "auto" },
    inputs: {
      narrative: {
        from: { capability: "narrative-engine@2", cardinality: "one" },
        required: true,
      },
    },
  };
  loaded.set(facts.name, {
    manifest: facts,
    promptTemplate: "",
    outputSchema: worldIRSchema,
    handler: async () => ({ outcome: "success", value: worldIR }),
  });
  const run = () =>
    executeTurn(
      {
        sessionId,
        turnId: "turn",
        origin: "player",
        playerMessage: "Gather supplies.",
        locale: "en",
      },
      [story, facts, ledger.manifest],
      {
        store,
        llm: {
          generate: async () => {
            throw new Error("The ledger must not call a model");
          },
        },
        getPluginSource: () => "builtin",
        loadRuntime: async (manifest) => loaded.get(manifest.name),
      },
    );
  const commit = (execution) =>
    commitExecution({
      store,
      execution,
      completion: {
        kind: "turn",
        turnId: execution.result.turnId,
        durationMs: 1,
      },
    });
  return { store, ledger, recorded, run, commit, rejected: () => rejected };
}

describe("inventory dataset schema", () => {
  it("loads the real ledger dataset and its shared import schema", async () => {
    const discovery = (
      await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
    ).find((entry) => entry.id === "inventory");
    const manifest = (await loadPluginManifest(discovery)).find(
      (entry) => entry.manifest.name === "inventory/ledger",
    ).manifest;
    const loaded = await loadRuntime(
      discovery,
      manifest.name,
      undefined,
      undefined,
      {
        "world-ir@1": JSON.parse(
          readFileSync(
            new URL(
              "../../world-ir/schemas/world-ir.schema.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      },
    );
    expect(loaded.manifest.datasets.items).toEqual({
      namespace: "items",
      schema: "./schemas/items.schema.json",
      key: "id",
      ops: ["set", "merge", "inc"],
    });
    expect(loaded.datasetSchemas.items).toEqual(schema);
  });

  it.each([
    { id: "torch", name: "Torch", quantity: -1 },
    { id: "torch", name: "Torch", quantity: 2, removed: true },
  ])("rejects invalid item records: %j", (value) => {
    expect(validateOutput(value, schema).valid).toBe(false);
  });

  it("supports the tombstone if/then guard under the declared JSON Schema draft", () => {
    expect(schema.if).toEqual({
      properties: { removed: { const: true } },
      required: ["removed"],
    });
    expect(schema.then).toEqual({ properties: { quantity: { const: 0 } } });
    expect(
      validateOutput(
        { id: "torch", name: "Torch", quantity: 0, removed: true },
        schema,
      ).valid,
    ).toBe(true);
    expect(
      validateOutput(
        { id: "torch", name: "Torch", quantity: 2, removed: true },
        schema,
      ).valid,
    ).toBe(false);
    for (const value of examples)
      expect(validateOutput(value, schema).valid).toBe(true);
  });
});

describe("inventory dataset commits through the real ledger", () => {
  it("commits add, remove and equip operations with the real dataset schema", async () => {
    const { store, ledger, recorded, run, commit } = await fixture();
    expect(ledger.manifest.datasets.items).toMatchObject({
      key: "id",
      ops: ["set", "merge", "inc"],
    });
    expect(ledger.datasetSchemas.items).toEqual(schema);
    const execution = await run();
    expect(
      execution.result.runtimeResults.map((entry) => [
        entry.runtimeId,
        entry.status,
      ]),
    ).toEqual([
      ["story", "success"],
      ["facts", "success"],
      ["inventory/ledger", "success"],
    ]);
    expect(
      (await store.getPluginData(sessionId, "inventory", "items", "torch"))
        .value,
    ).toEqual(initialItem);
    const result = recorded[0];
    expect(getToolContent(result).value).toMatchObject({
      applied: 4,
      skipped: 0,
    });
    const updates = getPendingProposals(result).filter(
      (proposal) => proposal.type === "plugin.data.update",
    );
    expect(updates).toHaveLength(2);
    const outcome = await commit(execution);
    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toEqual([]);
    expect(outcome.isolatedRuntimes ?? []).toEqual([]);
    for (const proposal of updates) {
      const { key, ops } = proposal.payload;
      const current =
        key === "torch"
          ? { exists: true, value: initialItem }
          : { exists: false };
      const expected =
        key === "torch"
          ? {
              ...initialItem,
              quantity: 4,
              equipped: true,
              updatedAt: proposal.timestamp,
            }
          : {
              id: key,
              name: "Rope",
              quantity: 1,
              description: "",
              tags: [],
              equipped: false,
              updatedAt: proposal.timestamp,
            };
      expect(applyDataOps(current, ops)).toEqual({
        ok: true,
        exists: true,
        value: expected,
      });
      expect(
        (await store.getPluginData(sessionId, "inventory", "items", key)).value,
      ).toEqual(expected);
    }
    expect(updates[0].payload.ops.map((op) => op.op)).toEqual([
      "inc",
      "merge",
      "inc",
      "merge",
      "merge",
    ]);
    expect(updates[1].payload.ops.map((op) => op.op)).toEqual(["set"]);
    expect(
      (
        await store.getPluginData(sessionId, "inventory", "message", "turn")
      ).value.changes.map((change) => change.op),
    ).toEqual(["add", "remove", "equip", "add"]);
  });

  it.each([
    ["disallowed append", { op: "append", path: "/tags", value: "forbidden" }],
    [
      "negative quantity via set",
      { op: "set", value: { id: "torch", name: "Torch", quantity: -1 } },
    ],
    [
      "positive tombstone via set",
      {
        op: "set",
        value: { id: "torch", name: "Torch", quantity: 2, removed: true },
      },
    ],
  ])(
    "refuses %s and rolls back only the ledger unit",
    async (_label, invalidWrite) => {
      const { store, run, commit, rejected } = await fixture(invalidWrite);
      const execution = await run();
      expect(
        execution.result.runtimeResults.find(
          (entry) => entry.runtimeId === "inventory/ledger",
        ).status,
      ).toBe("success");
      const outcome = await commit(execution);
      expect(outcome.status).toBe("committed");
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({
          proposal: rejected(),
          code: "dataset-violation",
        }),
      ]);
      expect(outcome.isolatedRuntimes.map((entry) => entry.runtimeId)).toEqual([
        "inventory/ledger",
      ]);
      expect(
        (await store.listPluginData(sessionId, "inventory", "items")).map(
          (row) => row.value,
        ),
      ).toEqual([initialItem]);
      expect(
        await store.getPluginData(sessionId, "inventory", "message", "turn"),
      ).toBeNull();
      expect(
        (await store.getPluginData(sessionId, "story", "saved", "turn")).value,
      ).toBe("Story preserved");
      const [saved] = await store.queryTurnResults(sessionId, {
        turnId: "turn",
        commitStatus: "committed",
      });
      expect(
        saved.runtimeResults.find((entry) => entry.runtimeId === "story")
          .status,
      ).toBe("success");
    },
  );
});
