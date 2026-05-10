import { describe, expect, it, vi } from "vitest";
import type { CharacterAttributeSchema } from "@covel/shared";
import {
  buildFieldsZod,
  formatFields,
  formatFieldValue,
  loadCharacterSchema,
  mirrorCharacterToPluginData,
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
    setPluginData: async () => {},
    ...overrides,
  };
}

describe("character tool helpers", () => {
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
    expect(
      toSnapshot({
        id: "char-1",
        sessionId: "session-1",
        name: "Mira",
        type: "npc",
        fields: { hp: 7 },
        version: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toEqual({
      id: "char-1",
      name: "Mira",
      type: "npc",
      fields: { hp: 7 },
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("mirrors character snapshots to plugin data with stable row identity", async () => {
    const setPluginData = vi.fn();
    const store = createStore({ setPluginData });

    await mirrorCharacterToPluginData(store, "session-1", "plugin-a", {
      id: "char-1",
      name: "Mira",
      type: "npc",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(setPluginData).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "char-mirror-char-1",
        sessionId: "session-1",
        pluginId: "plugin-a",
        namespace: "characters",
        key: "char-1",
      }),
    );
  });

  it("loads character schema through the resolved world-data provider", async () => {
    const getPluginData = vi.fn(async () => ({
      value: sampleSchema,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const store = createStore({ getPluginData });

    const result = await loadCharacterSchema(
      store,
      { findWorldDataPluginId: () => "world-provider" },
      "session-1",
    );

    expect(result).toBe(sampleSchema);
    expect(getPluginData).toHaveBeenCalledWith(
      "session-1",
      "world-provider",
      "schema",
      "character-attributes",
    );
  });

  it("treats missing schema dependencies or invalid rows as no schema", async () => {
    await expect(
      loadCharacterSchema(createStore(), {}, "session-1"),
    ).resolves.toBeNull();

    await expect(
      loadCharacterSchema(
        createStore({ getPluginData: async () => null }),
        { findWorldDataPluginId: () => "world-provider" },
        "session-1",
      ),
    ).resolves.toBeNull();

    await expect(
      loadCharacterSchema(
        createStore({
          getPluginData: async () => ({
            value: { version: 1, attributes: "bad" },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        }),
        { findWorldDataPluginId: () => "world-provider" },
        "session-1",
      ),
    ).resolves.toBeNull();
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
