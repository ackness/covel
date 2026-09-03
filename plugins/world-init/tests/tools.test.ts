import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../../packages/store/src/index.ts";
import { getPendingProposals, getToolContent, tool, z } from "@covel/tools";
import { createCommitPipeline } from "../../../packages/runtime/src/session/session-kernel.ts";
import initializeWorld from "../tools/initialize-world.js";
import setWorldSchema from "../tools/set-world-schema.js";
import setWorldEntriesBatch from "../tools/set-world-entries-batch.js";

const context = {
  sessionId: "sess-world-init",
  turnId: "turn-world-init",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
};

const categories = ["stats", "bio", "abilities", "equipment", "social"];

function makeAttributes() {
  return Array.from({ length: 15 }, (_, index) => ({
    id: `field${index + 1}`,
    name: `字段 ${index + 1}`,
    type: "string",
    category: categories[index % categories.length],
  }));
}

function makeEntries() {
  return [
    "geography",
    "factions",
    "power-system",
    "social-structure",
    "currency",
  ].map((key) => ({ key, value: { summary: `${key} data` } }));
}

describe("world-init local tools", () => {
  it("constructs the schema and entries tool modules", () => {
    const store = createMemoryStore();
    const injection = { tool, z, store };

    const schemaTool = setWorldSchema(injection);
    const entriesTool = setWorldEntriesBatch(injection);
    const initializeTool = initializeWorld(injection);

    expect(schemaTool._type).toBe("covel-tool");
    expect(schemaTool.name).toBe("set-world-schema");
    expect(entriesTool._type).toBe("covel-tool");
    expect(entriesTool.name).toBe("set-world-entries-batch");
    expect(initializeTool._type).toBe("covel-tool");
    expect(initializeTool.name).toBe("initialize-world");
  });

  it("publishes the complete atomic initialization schema to the model", () => {
    const store = createMemoryStore();
    const initializeTool = initializeWorld({ tool, z, store });

    expect(initializeTool.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        attributes: { type: "array", minItems: 15 },
        entries: { type: "array", minItems: 5 },
      },
    });
  });

  it("queues schema, plugin-data, and lorebook writes in one atomic call", async () => {
    const store = createMemoryStore();
    const initializeTool = initializeWorld({ tool, z, store });

    const rawResult = await initializeTool.execute(
      { attributes: makeAttributes(), entries: makeEntries() },
      context,
    );
    const result = getToolContent(rawResult);

    expect(result).toMatchObject({
      success: true,
      attributeCount: 15,
      categories,
      count: 5,
      keys: [
        "geography",
        "factions",
        "power-system",
        "social-structure",
        "currency",
      ],
      worldSchema: {
        "character-attributes": {
          version: 1,
          attributes: expect.any(Array),
        },
      },
      preGameDone: true,
    });
    expect(
      getPendingProposals(rawResult).map((proposal) => proposal.type),
    ).toEqual(["plugin.data", "plugin.data.batch", "lorebook.upsert"]);
  });

  it("rejects incomplete input before exposing any pending write", async () => {
    const store = createMemoryStore();
    const initializeTool = initializeWorld({ tool, z, store });

    await expect(
      initializeTool.execute(
        {
          attributes: makeAttributes(),
          entries: makeEntries().slice(0, 4),
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(
      await store.listPluginData(context.sessionId, "world-init", "schema"),
    ).toEqual([]);
    expect(
      await store.listPluginData(context.sessionId, "world-init", "entries"),
    ).toEqual([]);
    expect(await store.listSessionLorebookEntries(context.sessionId)).toEqual(
      [],
    );
  });

  it("requires all five attribute categories in the atomic call", async () => {
    const store = createMemoryStore();
    const initializeTool = initializeWorld({ tool, z, store });
    const attributes = makeAttributes().map((attribute) => ({
      ...attribute,
      category: attribute.category === "social" ? "bio" : attribute.category,
    }));

    await expect(
      initializeTool.execute({ attributes, entries: makeEntries() }, context),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("queues one schema proposal with versioned character attributes", async () => {
    const store = createMemoryStore();
    const schemaTool = setWorldSchema({ tool, z, store });

    const result = await schemaTool.execute(
      {
        attributes: [
          {
            id: "hp",
            name: "生命值",
            type: "number",
            min: 0,
            max: 100,
            defaultValue: 100,
            category: "stats",
            description: "当前生命值",
          },
          {
            id: "relationships",
            name: "人际",
            type: "map",
            valueType: "string",
            category: "social",
          },
        ],
      },
      context,
    );

    expect(result).toMatchObject({
      success: true,
      attributeCount: 2,
      categories: ["stats", "social"],
      worldSchema: {
        "character-attributes": {
          version: 1,
          attributes: expect.any(Array),
        },
      },
    });

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      sessionId: context.sessionId,
      turnId: context.turnId,
      source: { pluginId: "world-init", runtimeId: "world-init/schema-gen" },
      payload: {
        namespace: "schema",
        key: "character-attributes",
        value: {
          version: 1,
          attributes: [
            expect.objectContaining({
              id: "hp",
              type: "number",
              category: "stats",
            }),
            expect.objectContaining({
              id: "relationships",
              type: "map",
              category: "social",
            }),
          ],
        },
      },
    });
  });

  it("queues plugin-data and lorebook proposals for world entries", async () => {
    const store = createMemoryStore();
    const schemaTool = setWorldSchema({ tool, z, store });
    const entriesTool = setWorldEntriesBatch({ tool, z, store });
    const schemaResult = await schemaTool.execute(
      {
        attributes: [
          {
            id: "hp",
            name: "生命值",
            type: "number",
            category: "stats",
          },
        ],
      },
      context,
    );

    const result = await entriesTool.execute(
      {
        entries: [
          { key: "geography", value: { regions: ["云梦泽"] } },
          { key: "factions", value: { groups: ["青萍宗"] } },
        ],
      },
      { ...context, pendingProposals: getPendingProposals(schemaResult) },
    );

    expect(result).toMatchObject({
      success: true,
      count: 2,
      keys: ["geography", "factions"],
      preGameDone: true,
      worldSchema: {
        "character-attributes": {
          version: 1,
          attributes: [expect.objectContaining({ id: "hp" })],
        },
      },
    });

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data.batch",
      payload: {
        items: [
          {
            namespace: "entries",
            key: "geography",
            value: { regions: ["云梦泽"] },
          },
          {
            namespace: "entries",
            key: "factions",
            value: { groups: ["青萍宗"] },
          },
        ],
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "lorebook.upsert",
      payload: {
        entries: [
          {
            id: "world-entry:geography",
            keys: ["geography"],
            content: '[geography]\n{\n  "regions": [\n    "云梦泽"\n  ]\n}',
            strategy: "constant",
            position: "after_char_defs",
            insertionOrder: 100,
            enabled: true,
          },
          {
            id: "world-entry:factions",
            insertionOrder: 200,
          },
        ],
      },
    });
  });

  it("requires the schema proposal before completing world entries", async () => {
    const store = createMemoryStore();
    const entriesTool = setWorldEntriesBatch({ tool, z, store });

    await expect(
      entriesTool.execute(
        {
          entries: [{ key: "geography", value: { regions: ["云梦泽"] } }],
        },
        context,
      ),
    ).rejects.toThrow(
      "set-world-schema must succeed before set-world-entries-batch",
    );
  });

  it("commits queued world entries atomically through the kernel path", async () => {
    const store = createMemoryStore();
    const schemaTool = setWorldSchema({ tool, z, store });
    const entriesTool = setWorldEntriesBatch({ tool, z, store });
    const schemaResult = await schemaTool.execute(
      {
        attributes: [
          {
            id: "hp",
            name: "生命值",
            type: "number",
            category: "stats",
          },
        ],
      },
      context,
    );

    const result = await entriesTool.execute(
      {
        entries: [
          { key: "geography", value: { regions: ["云梦泽"] } },
          { key: "factions", value: { groups: ["青萍宗"] } },
        ],
      },
      { ...context, pendingProposals: getPendingProposals(schemaResult) },
    );

    const commitResults = await createCommitPipeline(store).commitAll(
      getPendingProposals(result),
    );
    expect(commitResults.every((item) => item.committed)).toBe(true);

    const pluginData = await store.listPluginData(
      context.sessionId,
      context.pluginId,
      "entries",
    );
    expect(pluginData.map((row) => row.key).sort()).toEqual([
      "factions",
      "geography",
    ]);

    const lorebook = await store.listSessionLorebookEntries(context.sessionId);
    expect(lorebook).toHaveLength(2);
    expect(lorebook[0]).toMatchObject({
      id: "world-entry:geography",
      pluginId: "world-init",
      keys: ["geography"],
      strategy: "constant",
      position: "after_char_defs",
      insertionOrder: 100,
      enabled: true,
    });
    expect(lorebook[0].content).toBe(
      '[geography]\n{\n  "regions": [\n    "云梦泽"\n  ]\n}',
    );
    expect(lorebook[1]).toMatchObject({
      id: "world-entry:factions",
      insertionOrder: 200,
    });
  });
});
