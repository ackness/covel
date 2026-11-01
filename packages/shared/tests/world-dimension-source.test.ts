import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import {
  validateWorldManifest,
  worldDataDescriptorSchema,
  worldDataSourceDescriptorSchema,
  worldDimensionsSchema,
  DIMENSION_MAX_NODES,
} from "../src/index.js";
import { buildManifestJsonSchemas } from "../scripts/generate-json-schemas.js";

const manifest = {
  id: "harbor",
  name: "Harbor",
  summary: "A harbor.",
  defaultLocale: "en-US",
};
const dimensions = {
  alarm: {
    name: "Alarm",
    schema: { type: "integer" as const, minimum: 0 },
    initialValue: 7,
  },
};

describe("one authored dimension source", () => {
  it("rejects inline authoring with a canonical-file hint while tolerant loading diagnoses and omits it", () => {
    expect(validateWorldManifest(manifest).valid).toBe(true);
    const raw = { ...manifest, dimensions };
    const strict = validateWorldManifest(raw);
    expect(strict.valid).toBe(false);
    expect(strict.errors).toContainEqual(
      expect.objectContaining({
        path: "dimensions",
        message: expect.stringContaining("data/dimensions.yaml"),
      }),
    );
    const tolerant = validateWorldManifest(raw, {
      ignoreUnknownRootFields: true,
    });
    expect(tolerant.valid).toBe(true);
    expect(tolerant.ignoredFields).toContain("dimensions");
    expect(tolerant.data).not.toHaveProperty("dimensions");
    expect(raw.dimensions).toEqual(dimensions);
  });

  it("emits a strict manifest JSON schema without dimension data", () => {
    const schemas = buildManifestJsonSchemas();
    const schema = schemas.world;
    const check = new Ajv({ strict: false }).compile(schema);
    expect(check(manifest)).toBe(true);
    expect(check({ ...manifest, dimensions })).toBe(false);
    expect(schema.properties).not.toHaveProperty("dimensions");
    expect(schemas.worldDimensions).toBeDefined();
  });

  it("retains full validation of external and portable dimension definitions", () => {
    expect(worldDimensionsSchema.safeParse(dimensions).success).toBe(true);
    for (const definition of [
      { ...dimensions.alarm, schema: { type: "integer", pattern: ".*" } },
      { ...dimensions.alarm, initialValue: -1 },
      {
        ...dimensions.alarm,
        schema: {},
        initialValue: Array.from({ length: DIMENSION_MAX_NODES + 1 }, () => 0),
      },
    ])
      expect(
        worldDimensionsSchema.safeParse({ alarm: definition }).success,
      ).toBe(false);
  });

  it("rejects noncanonical and duplicate descriptors without restricting generic contract sources", () => {
    const source = {
      kind: "yaml",
      path: "data/dimensions.yaml",
      to: "world:metadata.dimensions",
    };
    expect(
      worldDataDescriptorSchema.safeParse({ sources: { dimensions: source } })
        .success,
    ).toBe(true);
    expect(
      worldDataDescriptorSchema.safeParse({
        sources: { dimensions: { path: source.path, enabled: false } },
      }).success,
    ).toBe(true);
    for (const path of [
      "other.yaml",
      "data/dimensions.en-US.yaml",
      "data/dimensions.json",
    ])
      expect(
        worldDataSourceDescriptorSchema.safeParse({ ...source, path }).success,
      ).toBe(false);
    const duplicate = worldDataDescriptorSchema.safeParse({
      sources: {
        dimensions: source,
        second: { path: "./data/dimensions.yaml" },
      },
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success)
      expect(duplicate.error.issues[0]?.path).toEqual([
        "sources",
        "second",
        "path",
      ]);
    expect(
      worldDataSourceDescriptorSchema.safeParse({
        ...source,
        path: "other.yaml",
        to: "contract:example.data@1",
      }).success,
    ).toBe(true);
  });
});
