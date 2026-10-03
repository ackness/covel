import { describe, expect, it } from "vitest";
import {
  DIMENSION_MAX_DEPTH,
  DIMENSION_MAX_NODES,
  dimensionJsonError,
  dimensionSnapshotFromRecords,
  dimensionValueSchema,
  dimensionRecordSchema,
  materializeDimensionRecords,
  resolveDimensionDefinitionLocale,
  projectDimensionSnapshot,
  validateDimensionData,
  validateDimensionValue,
  worldDimensionsSchema,
  worldManifestSchema,
} from "../src/index.js";
import type { DimensionRecord, DimensionValueSchema } from "../src/index.js";

const wall = {
  name: "City wall",
  schema: { type: "integer" as const, minimum: 0, maximum: 100 },
  initialValue: 100,
  updateRule: "Update only after explicit damage or repair.",
};

describe("authored dimension definitions", () => {
  it("accepts arbitrary IDs through the manifest and single-file validator", () => {
    expect(worldDimensionsSchema.parse({ cityWall: wall })).toEqual({
      cityWall: wall,
    });
    expect(validateDimensionData("cityWall", wall).valid).toBe(true);
    const manifest = worldManifestSchema.parse({
      schemaVersion: "1.0",
      id: "wall",
      name: "Wall",
      summary: "Wall",
      defaultLocale: "en-US",
      dimensions: { cityWall: wall },
      dimensionSources: { discoveries: "discoveries.yaml" },
    });
    expect(manifest.dimensions?.cityWall?.initialValue).toBe(100);
  });

  it("rejects unsafe IDs, raw old values, unknown definition fields and bad initial values", () => {
    for (const id of [
      "constructor",
      "prototype",
      "__proto__",
      "bad id",
      "UPPER",
      "a".repeat(65),
    ]) {
      expect(validateDimensionData(id, wall).valid).toBe(false);
    }
    expect(
      worldDimensionsSchema.safeParse(JSON.parse('{"__proto__":{}}')).success,
    ).toBe(false);
    expect(
      worldDimensionsSchema.safeParse({ geography: { regions: [] } }).success,
    ).toBe(false);
    expect(
      worldDimensionsSchema.safeParse({ wall: { ...wall, initialValue: 101 } })
        .success,
    ).toBe(false);
    expect(
      worldDimensionsSchema.safeParse({
        wall: { ...wall, initialValue: "100" },
      }).success,
    ).toBe(false);
    expect(
      worldDimensionsSchema.safeParse({ wall: { ...wall, hidden: true } })
        .success,
    ).toBe(false);
  });

  it("rejects unsupported JSON Schema vocabulary instead of ignoring it", () => {
    for (const keyword of [
      "$ref",
      "$id",
      "pattern",
      "allOf",
      "format",
      "default",
    ]) {
      expect(
        dimensionValueSchema.safeParse({ type: "string", [keyword]: "ignored" })
          .success,
      ).toBe(false);
    }
    expect(
      dimensionValueSchema.safeParse({
        type: "object",
        properties: { nested: { pattern: ".*" } },
      }).success,
    ).toBe(false);
  });

  it("accepts localized titles and enum labels only for declared enum members", () => {
    const status = {
      type: "string" as const,
      title: { "zh-CN": "状态", "en-US": "Status" },
      enum: ["open", "closed"],
      "x-enumLabels": { open: { "zh-CN": "进行中", "en-US": "Open" } },
    };
    expect(dimensionValueSchema.safeParse(status).success).toBe(true);
    expect(validateDimensionValue(status, "open")).toEqual([]);
    expect(validateDimensionValue(status, "进行中")).not.toEqual([]);
    expect(
      dimensionValueSchema.safeParse({
        ...status,
        "x-enumLabels": { pending: "Pending" },
      }).success,
    ).toBe(false);
    expect(
      dimensionValueSchema.safeParse({
        type: "string",
        "x-enumLabels": { open: "Open" },
      }).success,
    ).toBe(false);
  });
});

describe("dimension value validation", () => {
  const row: DimensionValueSchema = {
    type: "object",
    properties: {
      level: { type: "integer", minimum: 0, maximum: 10 },
      name: { type: "string", minLength: 1, maxLength: 3 },
      equipped: { type: "boolean" },
    },
    required: ["level", "name"],
    additionalProperties: false,
  };

  it("validates named dynamic records and array rows", () => {
    const named: DimensionValueSchema = {
      type: "object",
      additionalProperties: row,
    };
    expect(
      validateDimensionValue(named, { climbing: { level: 3, name: "攀岩" } }),
    ).toEqual([]);
    expect(
      validateDimensionValue(named, {
        climbing: { level: 11, name: "攀岩" },
      })[0]?.path,
    ).toEqual(["climbing", "level"]);
    expect(
      validateDimensionValue(
        { type: "array", items: row, minItems: 1, maxItems: 2 },
        [{ level: 3, name: "岩" }],
      ),
    ).toEqual([]);
    expect(
      validateDimensionValue({ type: "array", items: row, minItems: 1 }, []),
    ).not.toEqual([]);
    expect(
      validateDimensionValue(row, { name: "岩", level: 1, invented: 1 })[0]
        ?.message,
    ).toBe("Unknown property");
    expect(validateDimensionValue(row, { level: 1 })[0]?.path).toEqual([
      "name",
    ]);
  });

  it("supports null, exclusive bounds, enums and structurally equal constants", () => {
    expect(validateDimensionValue({ type: ["number", "null"] }, null)).toEqual(
      [],
    );
    expect(validateDimensionValue({ type: "integer" }, 1.5)).not.toEqual([]);
    expect(
      validateDimensionValue(
        { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
        0,
      ),
    ).not.toEqual([]);
    expect(
      validateDimensionValue({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }),
    ).toEqual([]);
    expect(validateDimensionValue({ const: null }, null)).toEqual([]);
    expect(validateDimensionValue({ const: false }, true)).not.toEqual([]);
  });

  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(
      validateDimensionValue({ type: "string", maxLength: 1 }, "🌍"),
    ).toEqual([]);
  });

  it("rejects non-JSON, cycles and bounded tree overflows before recursion", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      1n,
      () => 1,
      cycle,
    ]) {
      expect(dimensionJsonError(value)).toBeDefined();
    }
    let deep: unknown = 1;
    for (let i = 0; i <= DIMENSION_MAX_DEPTH; i++) deep = [deep];
    expect(dimensionJsonError(deep)).toContain("depth");
    expect(dimensionJsonError(Array(DIMENSION_MAX_NODES).fill(0))).toContain(
      "node",
    );
    expect(dimensionJsonError("a".repeat(300000))).toContain("size");
  });
});

describe("public dimension snapshots and explicit localization", () => {
  it("omits maintenance rules and source/initial-value fields", () => {
    const record: DimensionRecord = {
      definition: wall,
      value: 80,
      version: 2,
      lastTrackedSource: { resultId: "source", turnNumber: 1 },
    };
    const snapshot = dimensionSnapshotFromRecords({ wall: record });
    expect(snapshot.wall).toEqual({
      name: "City wall",
      schema: wall.schema,
      value: 80,
      version: 2,
    });
    expect(snapshot.wall).not.toHaveProperty("initialValue");
    expect(snapshot.wall).not.toHaveProperty("updateRule");
    expect(snapshot.wall).not.toHaveProperty("lastTrackedSource");
  });

  it("resolves an authored definition for one content locale", () => {
    const schema: DimensionValueSchema = {
      type: "object",
      properties: {
        text: { type: "string", "x-i18n": true },
        data: { type: "object" },
      },
    };
    const authored = {
      name: { "zh-CN": "城防", "en-US": "Defences" },
      schema,
      initialValue: {
        text: { "zh-CN": "城墙", "en-US": "Wall" },
        // Ordinary data keyed by language codes is not translatable text.
        data: { zh: 1, en: 2 },
      },
      updateRule: { "zh-CN": "受损时更新。", "en-US": "Update on damage." },
    };
    expect(validateDimensionValue(schema, authored.initialValue)).toEqual([]);

    const resolved = resolveDimensionDefinitionLocale(authored, "en-US");
    expect(resolved.initialValue).toEqual({
      text: "Wall",
      data: { zh: 1, en: 2 },
    });
    expect(resolved.updateRule).toBe("Update on damage.");
    // Labels stay localizable: the panel shows them in the UI language.
    expect(resolved.name).toEqual(authored.name);
    expect(authored.initialValue.text).toEqual({
      "zh-CN": "城墙",
      "en-US": "Wall",
    });
  });

  it("adopts a re-declared authored definition without a conflict", () => {
    const schema: DimensionValueSchema = { type: "string", "x-i18n": true };
    const authored = {
      name: "Wall",
      schema,
      initialValue: { "zh-CN": "城墙", "en-US": "Wall" },
    };
    const proposal = {
      id: "p1",
      type: "dimension.initialize" as const,
      sessionId: "s",
      turnId: "t",
      source: { pluginId: "world-init", runtimeId: "world-init/schema-gen" },
      payload: { definitions: { wall: authored } },
      timestamp: "2026-10-03T00:00:00Z",
    };
    // The import stored the en-US text. A plugin then declares the package's
    // definition again, locale maps included.
    const imported = materializeDimensionRecords({}, proposal, "en-US");
    expect(imported.wall).toMatchObject({
      value: "Wall",
      definition: { initialValue: "Wall" },
    });
    expect(materializeDimensionRecords(imported, proposal, "en-US")).toEqual(
      imported,
    );
  });

  it("accepts a locale map in a package and only a string in session state", () => {
    const schema: DimensionValueSchema = { type: "string", "x-i18n": true };
    const map = { "zh-CN": "城墙", "en-US": "Wall" };
    expect(validateDimensionValue(schema, map)).toEqual([]);
    expect(
      validateDimensionValue(schema, map, { localized: "resolved" }),
    ).toEqual([
      {
        path: [],
        message:
          "Expected a string. Write this text once, in the session language; do not supply a locale map",
      },
    ]);
    expect(
      validateDimensionValue(schema, "城墙", { localized: "resolved" }),
    ).toEqual([]);

    const record = (value: unknown, initialValue: unknown) =>
      dimensionRecordSchema.safeParse({
        definition: { name: "Wall", schema, initialValue },
        value,
        version: 1,
      }).success;
    expect(record("城墙", "城墙")).toBe(true);
    expect(record(map, "城墙")).toBe(false);
    expect(record("城墙", map)).toBe(false);
  });

  it("names the translation and its length when a localized text is too long", () => {
    const schema: DimensionValueSchema = {
      type: "object",
      properties: { note: { type: "string", maxLength: 5, "x-i18n": true } },
    };
    expect(
      validateDimensionValue(schema, {
        note: { "zh-CN": "城墙", "en-US": "City wall" },
      }),
    ).toEqual([
      { path: ["note", "en-US"], message: "Maximum length is 5 (got 9)" },
    ]);
  });
});

describe("projectDimensionSnapshot", () => {
  const entry = (value: unknown) => ({
    name: "D",
    schema: { type: "string" } as DimensionValueSchema,
    value,
    version: 1,
  });

  it("shows every value whole while the snapshot fits", () => {
    const long = "x".repeat(900);
    const text = projectDimensionSnapshot({
      lore: entry(long),
      mood: entry("calm"),
    });
    expect(text).toContain(JSON.stringify(long));
    expect(text).not.toContain("…");
  });

  it("cuts the longest values first until the snapshot fits", () => {
    const text = projectDimensionSnapshot(
      {
        big: entry("b".repeat(3000)),
        medium: entry("m".repeat(1500)),
        small: entry("s".repeat(300)),
      },
      undefined,
      2400,
    );
    expect(text).toContain(`big (D, v1): "${"b".repeat(239)}…`);
    expect(text).toContain(JSON.stringify("m".repeat(1500)));
    expect(text).toContain(JSON.stringify("s".repeat(300)));
  });
});
