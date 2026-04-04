/**
 * Tests for createBuiltinDataTools().
 *
 * Validates each builtin data tool's handler logic against a mock
 * PluginDataAccess. Covers normal usage, edge cases, missing/invalid input,
 * and proposal generation for write tools.
 */
import { describe, it, expect, vi } from "vitest";
import { createBuiltinDataTools } from "../src/tools/builtin-data-tools.js";
import type { BuiltinToolEntry } from "../src/tools/builtin-data-tools.js";
import type { PluginDataAccess, ProposalItem } from "@covel/shared";

// ── Mock factory ─────────────────────────────────────────────────────────────

/** Creates a fully mocked PluginDataAccess that tracks all calls. */
function createMockDataAccess(): PluginDataAccess {
  return {
    state: {
      get: vi.fn(),
      getScope: vi.fn(),
      getAll: vi.fn(),
    },
    records: {
      get: vi.fn(),
      find: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
    },
    characters: {
      get: vi.fn(),
      findByName: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      listByType: vi.fn().mockReturnValue([]),
    },
    events: {
      recent: vi.fn().mockReturnValue([]),
      findByType: vi.fn().mockReturnValue([]),
    },
    propose: {
      statePatch: vi.fn().mockReturnValue({ kind: "state.patch", payload: {} }),
      eventEmit: vi.fn().mockReturnValue({ kind: "event.emit", payload: {} }),
      recordUpsert: vi.fn().mockReturnValue({ kind: "record.upsert", payload: {} }),
      narrativeAppend: vi.fn().mockReturnValue({ kind: "narrative.append", payload: {} }),
      uiRender: vi.fn().mockReturnValue({ kind: "ui.render", payload: {} }),
      characterCreate: vi.fn().mockReturnValue({ kind: "character.create", payload: {} }),
      characterUpdate: vi.fn().mockReturnValue({ kind: "character.update", payload: {} }),
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal ToolExecutionContext for testing. */
function makeCtx(input: unknown) {
  return {
    input,
    runtimeId: "test-runtime",
    pluginId: "test-plugin",
    locale: "en-US",
  };
}

/** Find a tool entry by its definition ID. */
function findTool(tools: BuiltinToolEntry[], id: string): BuiltinToolEntry {
  const tool = tools.find((t) => t.definition.id === id);
  if (!tool) throw new Error(`Tool not found: ${id}`);
  return tool;
}

// ── state.get ────────────────────────────────────────────────────────────────

describe("state.get", () => {
  it("should return scoped state value for scope + key", async () => {
    const da = createMockDataAccess();
    da.state.get = vi.fn().mockReturnValue(42);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx({ scope: "combat", key: "hp" }));

    expect(da.state.get).toHaveBeenCalledWith("combat", "hp");
    expect(result.output).toBe(42);
  });

  it("should return entire scope when key is omitted", async () => {
    const da = createMockDataAccess();
    const scopeData = { hp: 100, mp: 50 };
    da.state.getScope = vi.fn().mockReturnValue(scopeData);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx({ scope: "combat" }));

    expect(da.state.getScope).toHaveBeenCalledWith("combat");
    expect(result.output).toEqual(scopeData);
  });

  it("should return null when scope data is undefined", async () => {
    const da = createMockDataAccess();
    da.state.getScope = vi.fn().mockReturnValue(undefined);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx({ scope: "nonexistent" }));
    expect(result.output).toBeNull();
  });

  it("should return error when scope is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx({}));
    expect(result.output).toEqual({ error: "Missing required parameter: scope" });
  });

  it("should return error when input is undefined", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx(undefined));
    expect(result.output).toEqual({ error: "Missing required parameter: scope" });
  });

  it("should return error when scope is not a string", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.get");

    const result = await tool.handler(makeCtx({ scope: 123 }));
    expect(result.output).toEqual({ error: "Missing required parameter: scope" });
  });
});

// ── record.search ────────────────────────────────────────────────────────────

describe("record.search", () => {
  it("should list records with recordType filter", async () => {
    const da = createMockDataAccess();
    const records = [{ key: "q1", recordType: "quest", fields: {} }];
    da.records.list = vi.fn().mockReturnValue(records);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.search");

    const result = await tool.handler(makeCtx({ recordType: "quest" }));

    expect(da.records.list).toHaveBeenCalledWith("quest");
    expect(result.output).toEqual(records);
  });

  it("should list all records without recordType", async () => {
    const da = createMockDataAccess();
    da.records.list = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.search");

    await tool.handler(makeCtx({}));
    expect(da.records.list).toHaveBeenCalledWith(undefined);
  });

  it("should respect custom limit", async () => {
    const da = createMockDataAccess();
    const manyRecords = Array.from({ length: 50 }, (_, i) => ({
      key: `r${i}`,
      recordType: "item",
      fields: {},
    }));
    da.records.list = vi.fn().mockReturnValue(manyRecords);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.search");

    const result = await tool.handler(makeCtx({ limit: 5 }));
    expect((result.output as unknown[]).length).toBe(5);
  });

  it("should use default limit of 20", async () => {
    const da = createMockDataAccess();
    const manyRecords = Array.from({ length: 30 }, (_, i) => ({
      key: `r${i}`,
      recordType: "item",
      fields: {},
    }));
    da.records.list = vi.fn().mockReturnValue(manyRecords);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.search");

    const result = await tool.handler(makeCtx({}));
    expect((result.output as unknown[]).length).toBe(20);
  });

  it("should handle null input gracefully", async () => {
    const da = createMockDataAccess();
    da.records.list = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.search");

    const result = await tool.handler(makeCtx(null));
    expect(result.output).toEqual([]);
  });
});

// ── record.get ───────────────────────────────────────────────────────────────

describe("record.get", () => {
  it("should return record for valid key", async () => {
    const da = createMockDataAccess();
    const record = { key: "quest-1", recordType: "quest", fields: { status: "active" } };
    da.records.get = vi.fn().mockReturnValue(record);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.get");

    const result = await tool.handler(makeCtx({ key: "quest-1" }));

    expect(da.records.get).toHaveBeenCalledWith("quest-1");
    expect(result.output).toEqual(record);
  });

  it("should return null for non-existent key", async () => {
    const da = createMockDataAccess();
    da.records.get = vi.fn().mockReturnValue(undefined);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.get");

    const result = await tool.handler(makeCtx({ key: "missing" }));
    expect(result.output).toBeNull();
  });

  it("should return error when key is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.get");

    const result = await tool.handler(makeCtx({}));
    expect(result.output).toEqual({ error: "Missing required parameter: key" });
  });

  it("should return error when input is undefined", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.get");

    const result = await tool.handler(makeCtx(undefined));
    expect(result.output).toEqual({ error: "Missing required parameter: key" });
  });

  it("should return error when key is not a string", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.get");

    const result = await tool.handler(makeCtx({ key: 42 }));
    expect(result.output).toEqual({ error: "Missing required parameter: key" });
  });
});

// ── character.list ───────────────────────────────────────────────────────────

describe("character.list", () => {
  it("should return all characters when no type filter", async () => {
    const da = createMockDataAccess();
    const chars = [{ id: "c1", name: "Hero" }, { id: "c2", name: "Villain" }];
    da.characters.list = vi.fn().mockReturnValue(chars);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.list");

    const result = await tool.handler(makeCtx({}));

    expect(da.characters.list).toHaveBeenCalled();
    expect(result.output).toEqual(chars);
  });

  it("should filter by type when provided", async () => {
    const da = createMockDataAccess();
    const npcs = [{ id: "c2", name: "Shopkeeper", type: "npc" }];
    da.characters.listByType = vi.fn().mockReturnValue(npcs);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.list");

    const result = await tool.handler(makeCtx({ type: "npc" }));

    expect(da.characters.listByType).toHaveBeenCalledWith("npc");
    expect(da.characters.list).not.toHaveBeenCalled();
    expect(result.output).toEqual(npcs);
  });

  it("should handle null input gracefully", async () => {
    const da = createMockDataAccess();
    da.characters.list = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.list");

    const result = await tool.handler(makeCtx(null));
    expect(result.output).toEqual([]);
  });
});

// ── character.get ────────────────────────────────────────────────────────────

describe("character.get", () => {
  it("should get character by id", async () => {
    const da = createMockDataAccess();
    const char = { id: "c1", name: "Hero" };
    da.characters.get = vi.fn().mockReturnValue(char);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx({ id: "c1" }));

    expect(da.characters.get).toHaveBeenCalledWith("c1");
    expect(result.output).toEqual(char);
  });

  it("should get character by name", async () => {
    const da = createMockDataAccess();
    const char = { id: "c1", name: "Hero" };
    da.characters.findByName = vi.fn().mockReturnValue(char);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx({ name: "Hero" }));

    expect(da.characters.findByName).toHaveBeenCalledWith("Hero");
    expect(result.output).toEqual(char);
  });

  it("should prefer id over name when both provided", async () => {
    const da = createMockDataAccess();
    const char = { id: "c1", name: "Hero" };
    da.characters.get = vi.fn().mockReturnValue(char);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx({ id: "c1", name: "Hero" }));

    expect(da.characters.get).toHaveBeenCalledWith("c1");
    expect(da.characters.findByName).not.toHaveBeenCalled();
    expect(result.output).toEqual(char);
  });

  it("should return null when neither id nor name provided", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx({}));
    expect(result.output).toBeNull();
  });

  it("should return null when character not found", async () => {
    const da = createMockDataAccess();
    da.characters.get = vi.fn().mockReturnValue(undefined);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx({ id: "nonexistent" }));
    expect(result.output).toBeNull();
  });

  it("should handle null input gracefully", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "character.get");

    const result = await tool.handler(makeCtx(null));
    expect(result.output).toBeNull();
  });
});

// ── event.recent ─────────────────────────────────────────────────────────────

describe("event.recent", () => {
  it("should return recent events with default limit", async () => {
    const da = createMockDataAccess();
    const events = [{ eventType: "combat.start" }, { eventType: "quest.complete" }];
    da.events.recent = vi.fn().mockReturnValue(events);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.recent");

    const result = await tool.handler(makeCtx({}));

    expect(da.events.recent).toHaveBeenCalledWith(20);
    expect(result.output).toEqual(events);
  });

  it("should pass custom limit", async () => {
    const da = createMockDataAccess();
    da.events.recent = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.recent");

    await tool.handler(makeCtx({ limit: 5 }));
    expect(da.events.recent).toHaveBeenCalledWith(5);
  });

  it("should filter by eventType", async () => {
    const da = createMockDataAccess();
    const events = [{ eventType: "combat.start" }];
    da.events.findByType = vi.fn().mockReturnValue(events);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.recent");

    const result = await tool.handler(makeCtx({ eventType: "combat.start" }));

    expect(da.events.findByType).toHaveBeenCalledWith("combat.start", 20);
    expect(da.events.recent).not.toHaveBeenCalled();
    expect(result.output).toEqual(events);
  });

  it("should pass limit with eventType filter", async () => {
    const da = createMockDataAccess();
    da.events.findByType = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.recent");

    await tool.handler(makeCtx({ eventType: "combat.start", limit: 3 }));
    expect(da.events.findByType).toHaveBeenCalledWith("combat.start", 3);
  });

  it("should handle null input gracefully", async () => {
    const da = createMockDataAccess();
    da.events.recent = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.recent");

    const result = await tool.handler(makeCtx(null));
    expect(result.output).toEqual([]);
  });
});

// ── state.patch (write) ──────────────────────────────────────────────────────

describe("state.patch", () => {
  it("should return proposal for valid input", async () => {
    const da = createMockDataAccess();
    const proposal: ProposalItem = { kind: "state.patch", payload: { scope: "combat", patch: { hp: 80 } } };
    da.propose.statePatch = vi.fn().mockReturnValue(proposal);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx({ scope: "combat", patch: { hp: 80 } }));

    expect(da.propose.statePatch).toHaveBeenCalledWith("combat", { hp: 80 });
    expect(result.output).toEqual({ ok: true, scope: "combat" });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals![0]).toEqual(proposal);
  });

  it("should return error when scope is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx({ patch: { hp: 80 } }));
    expect(result.output).toEqual({ error: "Missing required parameters: scope and patch" });
    expect(result.proposals).toBeUndefined();
  });

  it("should return error when patch is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx({ scope: "combat" }));
    expect(result.output).toEqual({ error: "Missing required parameters: scope and patch" });
  });

  it("should return error when both are missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx({}));
    expect(result.output).toEqual({ error: "Missing required parameters: scope and patch" });
  });

  it("should return error when input is undefined", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx(undefined));
    expect(result.output).toEqual({ error: "Missing required parameters: scope and patch" });
  });

  it("should return error when patch is not an object", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "state.patch");

    const result = await tool.handler(makeCtx({ scope: "combat", patch: "not-object" }));
    expect(result.output).toEqual({ error: "Missing required parameters: scope and patch" });
  });
});

// ── record.upsert (write) ────────────────────────────────────────────────────

describe("record.upsert", () => {
  it("should return proposal for valid input", async () => {
    const da = createMockDataAccess();
    const proposal: ProposalItem = { kind: "record.upsert", payload: {} };
    da.propose.recordUpsert = vi.fn().mockReturnValue(proposal);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(
      makeCtx({ recordType: "quest", key: "q1", fields: { title: "Main Quest" } })
    );

    expect(da.propose.recordUpsert).toHaveBeenCalledWith("quest", "q1", { title: "Main Quest" });
    expect(result.output).toEqual({ ok: true, key: "q1" });
    expect(result.proposals).toHaveLength(1);
  });

  it("should return error when recordType is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(makeCtx({ key: "q1", fields: { x: 1 } }));
    expect(result.output).toEqual({
      error: "Missing required parameters: recordType, key, and fields",
    });
  });

  it("should return error when key is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(makeCtx({ recordType: "quest", fields: { x: 1 } }));
    expect(result.output).toEqual({
      error: "Missing required parameters: recordType, key, and fields",
    });
  });

  it("should return error when fields is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(makeCtx({ recordType: "quest", key: "q1" }));
    expect(result.output).toEqual({
      error: "Missing required parameters: recordType, key, and fields",
    });
  });

  it("should return error when input is undefined", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(makeCtx(undefined));
    expect(result.output).toEqual({
      error: "Missing required parameters: recordType, key, and fields",
    });
  });

  it("should return error when fields is not an object", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "record.upsert");

    const result = await tool.handler(
      makeCtx({ recordType: "quest", key: "q1", fields: "not-object" })
    );
    expect(result.output).toEqual({
      error: "Missing required parameters: recordType, key, and fields",
    });
  });
});

// ── event.emit (write) ──────────────────────────────────────────────────────

describe("event.emit", () => {
  it("should return proposal for valid eventType", async () => {
    const da = createMockDataAccess();
    const proposal: ProposalItem = { kind: "event.emit", payload: {} };
    da.propose.eventEmit = vi.fn().mockReturnValue(proposal);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    const result = await tool.handler(makeCtx({ eventType: "combat.start" }));

    expect(da.propose.eventEmit).toHaveBeenCalledWith("combat.start", undefined);
    expect(result.output).toEqual({ ok: true, eventType: "combat.start" });
    expect(result.proposals).toHaveLength(1);
  });

  it("should pass data when provided", async () => {
    const da = createMockDataAccess();
    da.propose.eventEmit = vi.fn().mockReturnValue({ kind: "event.emit", payload: {} });
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    await tool.handler(makeCtx({ eventType: "quest.complete", data: { questId: "q1" } }));
    expect(da.propose.eventEmit).toHaveBeenCalledWith("quest.complete", { questId: "q1" });
  });

  it("should return error when eventType is missing", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    const result = await tool.handler(makeCtx({}));
    expect(result.output).toEqual({ error: "Missing required parameter: eventType" });
    expect(result.proposals).toBeUndefined();
  });

  it("should return error when input is undefined", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    const result = await tool.handler(makeCtx(undefined));
    expect(result.output).toEqual({ error: "Missing required parameter: eventType" });
  });

  it("should return error when eventType is not a string", async () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    const result = await tool.handler(makeCtx({ eventType: 123 }));
    expect(result.output).toEqual({ error: "Missing required parameter: eventType" });
  });

  it("should ignore data when it is not an object", async () => {
    const da = createMockDataAccess();
    da.propose.eventEmit = vi.fn().mockReturnValue({ kind: "event.emit", payload: {} });
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "event.emit");

    await tool.handler(makeCtx({ eventType: "test", data: "not-object" }));
    expect(da.propose.eventEmit).toHaveBeenCalledWith("test", undefined);
  });
});

// ── ui.render (write) ────────────────────────────────────────────────────────

describe("ui.render", () => {
  it("should return proposal for valid blockType and data", async () => {
    const da = createMockDataAccess();
    const proposal: ProposalItem = { kind: "ui.render", payload: {} };
    da.propose.uiRender = vi.fn().mockReturnValue(proposal);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "ui.render");

    const result = await tool.handler(
      makeCtx({ blockType: "choice_set", data: { options: ["a", "b"] } })
    );

    expect(da.propose.uiRender).toHaveBeenCalledWith(
      "choice_set",
      { options: ["a", "b"] },
      undefined
    );
    expect(result.output).toEqual({ ok: true, blockType: "choice_set" });
    expect(result.proposals).toHaveLength(1);
  });

  it("should pass interaction options when interactive is true", async () => {
    const da = createMockDataAccess();
    da.propose.uiRender = vi.fn().mockReturnValue({ kind: "ui.render", payload: {} });
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "ui.render");

    await tool.handler(
      makeCtx({ blockType: "choice_set", data: { options: ["a"] }, interactive: true })
    );

    expect(da.propose.uiRender).toHaveBeenCalledWith(
      "choice_set",
      { options: ["a"] },
      { requiresResponse: true }
    );
  });

  it("should not pass interaction options when interactive is false", async () => {
    const da = createMockDataAccess();
    da.propose.uiRender = vi.fn().mockReturnValue({ kind: "ui.render", payload: {} });
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const tool = findTool(tools, "ui.render");

    await tool.handler(
      makeCtx({ blockType: "narrative", data: { text: "hello" }, interactive: false })
    );

    expect(da.propose.uiRender).toHaveBeenCalledWith(
      "narrative",
      { text: "hello" },
      undefined
    );
  });
});

// ── Tool definitions ─────────────────────────────────────────────────────────

describe("Tool definitions", () => {
  it("should return all expected tools", () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const ids = tools.map((t) => t.definition.id);

    expect(ids).toContain("state.get");
    expect(ids).toContain("record.search");
    expect(ids).toContain("record.get");
    expect(ids).toContain("character.list");
    expect(ids).toContain("character.get");
    expect(ids).toContain("event.recent");
    expect(ids).toContain("state.patch");
    expect(ids).toContain("record.upsert");
    expect(ids).toContain("event.emit");
    expect(ids).toContain("ui.render");
  });

  it("should assign correct kinds to tools", () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });
    const byId = Object.fromEntries(tools.map((t) => [t.definition.id, t.definition]));

    expect(byId["state.get"].kind).toBe("query");
    expect(byId["record.search"].kind).toBe("query");
    expect(byId["record.get"].kind).toBe("query");
    expect(byId["character.list"].kind).toBe("query");
    expect(byId["character.get"].kind).toBe("query");
    expect(byId["event.recent"].kind).toBe("query");
    expect(byId["state.patch"].kind).toBe("mutate");
    expect(byId["record.upsert"].kind).toBe("mutate");
    expect(byId["event.emit"].kind).toBe("emit");
    expect(byId["ui.render"].kind).toBe("render");
  });

  it("should have schemas on all tools", () => {
    const da = createMockDataAccess();
    const tools = createBuiltinDataTools({ getDataAccess: () => da });

    for (const tool of tools) {
      expect(tool.definition.schema).toBeDefined();
      expect(tool.definition.schema.type).toBe("object");
    }
  });
});

// ── Extra fields resilience ──────────────────────────────────────────────────

describe("Input resilience", () => {
  it("should not crash with extra fields in input", async () => {
    const da = createMockDataAccess();
    da.state.getScope = vi.fn().mockReturnValue({});
    da.records.list = vi.fn().mockReturnValue([]);
    da.characters.list = vi.fn().mockReturnValue([]);
    da.events.recent = vi.fn().mockReturnValue([]);
    const tools = createBuiltinDataTools({ getDataAccess: () => da });

    // Each tool should handle extra fields without crashing
    const stateGet = findTool(tools, "state.get");
    await expect(
      stateGet.handler(makeCtx({ scope: "test", extraField: true, nested: { a: 1 } }))
    ).resolves.toBeDefined();

    const recordSearch = findTool(tools, "record.search");
    await expect(
      recordSearch.handler(makeCtx({ recordType: "quest", foo: "bar" }))
    ).resolves.toBeDefined();

    const charList = findTool(tools, "character.list");
    await expect(
      charList.handler(makeCtx({ type: "npc", extra: 123 }))
    ).resolves.toBeDefined();

    const eventRecent = findTool(tools, "event.recent");
    await expect(
      eventRecent.handler(makeCtx({ limit: 5, debug: true }))
    ).resolves.toBeDefined();
  });
});
