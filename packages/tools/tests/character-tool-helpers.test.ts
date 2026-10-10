import { describe, expect, it, vi } from "vitest";
import type { CharacterAttributeSchema } from "@covel/shared";
import {
  buildFieldsZod,
  assertCharacterFields,
  formatFields,
  formatFieldValue,
  loadCharacterSchema,
  mergeSchemaDefaults,
  sortByFrequencyThenRecency,
  toSnapshot,
  truncate,
  type CharacterStore,
} from "../src/builtin/character-tool-helpers.js";

const sampleSchema: CharacterAttributeSchema = {
  version: 1,
  attributes: [
    {
      id: "hp",
      name: "HP",
      type: "number",
      min: 0,
      max: 100,
      category: "stats",
    },
  ],
};

function createStore(overrides: Partial<CharacterStore> = {}): CharacterStore {
  return {
    upsertCharacter: async () => {},
    listCharacters: async () => [],
    getCharacterSchema: async () => null,
    ...overrides,
  };
}

describe("character tool helpers", () => {
  it.each(["self-taught", -1, 101, null, Infinity])(
    "rejects invalid declared attribute %j at the write boundary",
    (hp) => {
      expect(() => mergeSchemaDefaults({ hp }, sampleSchema)).toThrow(/hp/);
      expect(() => assertCharacterFields({ hp }, sampleSchema)).toThrow(/hp/);
    },
  );
  it("preserves valid zero values and separate descriptive fields", () => {
    expect(
      mergeSchemaDefaults({ hp: 0, background: "self-taught" }, sampleSchema),
    ).toEqual({ hp: 0, background: "self-taught" });
  });
  it("formats primitive, array, object, and empty field values", () => {
    expect(formatFieldValue(undefined)).toBe("—");
    expect(formatFieldValue("ready")).toBe("ready");
    expect(formatFieldValue(["fast", 2, true])).toBe("[fast, 2, true]");
    expect(formatFieldValue([{ k: "v" }])).toBe('[{"k":"v"}]');
    expect(formatFieldValue({ hp: 10 })).toBe('{"hp":10}');

    expect(formatFields({ hp: 10, traits: ["fast"] })).toEqual([
      "  hp: 10",
      "  traits: [fast]",
    ]);
    expect(formatFields(null)).toEqual([]);
  });

  it("leaves bookkeeping out of attribute text", () => {
    const row = {
      id: "0b6f6a2e-3c1d-4f5a-9b7e-1a2b3c4d5e6f",
      note: "kept",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(formatFieldValue(row)).toBe('{"note":"kept"}');
    expect(formatFieldValue([row])).toBe('[{"note":"kept"}]');
    expect(formatFields({ history: row })).toEqual([
      '  history: {"note":"kept"}',
    ]);
  });

  it("sorts by version descending and then updatedAt descending", () => {
    const sorted = sortByFrequencyThenRecency([
      { id: "old-v2", version: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "v1", version: 1, updatedAt: "2026-01-03T00:00:00.000Z" },
      { id: "new-v2", version: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["new-v2", "old-v2", "v1"]);
  });

  it("truncates compact text without changing short or empty values", () => {
    expect(truncate(undefined, 8)).toBe("");
    expect(truncate("short", 8)).toBe("short");
    expect(truncate("longer text", 8)).toBe("longer …");
  });

  it("creates a public snapshot without session-only fields", () => {
    // A stored record carries sessionId; a variable avoids the excess-property check.
    const record = {
      id: "char-1",
      sessionId: "session-1",
      name: "Mira",
      type: "npc",
      fields: { hp: 7 },
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(toSnapshot(record)).toEqual({
      id: "char-1",
      name: "Mira",
      type: "npc",
      fields: { hp: 7 },
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("loads the authoritative session character schema", async () => {
    const schema = {
      ...sampleSchema,
      types: ["enemy"],
      sessionId: "session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const getCharacterSchema = vi.fn(async () => schema);
    expect(
      await loadCharacterSchema(
        createStore({ getCharacterSchema }),
        "session-1",
      ),
    ).toEqual(schema);
    expect(getCharacterSchema).toHaveBeenCalledWith("session-1");
  });

  it("returns null when the session has no schema", async () => {
    expect(await loadCharacterSchema(createStore(), "session-1")).toBeNull();
  });

  it("merges declared schema defaults into stored fields without mutating input", () => {
    const schema: CharacterAttributeSchema = {
      version: 1,
      attributes: [
        {
          id: "hp",
          name: "HP",
          type: "number",
          defaultValue: 100,
          category: "stats",
        },
        {
          id: "trust",
          name: "Trust",
          type: "number",
          defaultValue: 0,
          category: "social",
        },
        { id: "club", name: "Club", type: "string", category: "social" }, // no default
      ],
    };
    const input = { trust: 42 };
    const merged = mergeSchemaDefaults(input, schema);

    // Player-set value wins; missing default filled; no-default attr untouched.
    expect(merged).toEqual({ trust: 42, hp: 100 });
    // Input not mutated.
    expect(input).toEqual({ trust: 42 });
  });

  it("returns a plain copy when schema is null or fields are non-object", () => {
    expect(mergeSchemaDefaults({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeSchemaDefaults(undefined, null)).toEqual({});
    expect(mergeSchemaDefaults("nope", sampleSchema)).toEqual({});
  });

  it("builds generic or schema-aware fields zod shapes", () => {
    type ZodJsonSchema = { toJSONSchema(): Record<string, unknown> };

    const generic = buildFieldsZod(null) as unknown as ZodJsonSchema;
    expect(generic.toJSONSchema()).toMatchObject({
      type: "object",
      additionalProperties: {},
    });

    const typed = buildFieldsZod(sampleSchema) as unknown as ZodJsonSchema;
    const schema = typed.toJSONSchema() as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.hp).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 100,
    });
  });
});
