import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkStrictToolSchema,
  strictToolCapabilitySchema,
} from "../src/index.js";
import {
  mergeRequestCapabilityOverride,
  resolveCapability,
} from "../src/capability/resolver.js";
import { selectStrictTools } from "../src/capability/strict-tools.js";
import {
  closedSchema,
  strictCapability,
  strictProfile,
} from "./strict-tool-fixture.js";
import { defaultToolChoice } from "../src/adapters/request-defaults.js";

describe("lossless strict tool schemas", () => {
  it.each([
    { accepted: ["auto"] as const, expected: "auto" },
    { accepted: ["auto", "required"] as const, expected: "required" },
    {
      accepted: ["auto", "required", "named"] as const,
      expected: { type: "function", function: { name: "submit-output" } },
    },
  ])(
    "narrows submission choice without changing reasoning: %j",
    ({ accepted, expected }) => {
      const body = { thinking: { type: "enabled" } };
      expect(
        defaultToolChoice(
          { toolChoice: { name: "submit-output" } },
          body,
          "chat",
          { thinksByDefault: true, toolChoiceWhileThinking: [...accepted] },
        ),
      ).toEqual(expected);
      expect(body).toEqual({ thinking: { type: "enabled" } });
    },
  );
  it("accepts a compatible schema without mutation", () => {
    const before = structuredClone(closedSchema);
    expect(checkStrictToolSchema(closedSchema, strictProfile)).toEqual({
      compatible: true,
      issues: [],
    });
    expect(closedSchema).toEqual(before);
  });
  it.each([
    { type: "array", items: { type: "string" } },
    {
      type: "object",
      properties: { optional: { type: "string" } },
      additionalProperties: false,
    },
    { type: "object", properties: {}, required: [] },
    {
      ...closedSchema,
      properties: { ok: { type: "boolean", unsupported: true } },
    },
    { ...closedSchema, properties: { ok: { type: ["boolean", "null"] } } },
    {
      ...closedSchema,
      properties: { ok: { type: "string", format: "email" } },
    },
    { ...closedSchema, properties: { ok: { type: "string", minLength: 1 } } },
    {
      ...closedSchema,
      properties: { ok: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
    },
    {
      ...closedSchema,
      // oxlint-disable-next-line unicorn/no-thenable -- This is a JSON Schema conditional keyword.
      properties: { ok: { if: { const: true }, then: { type: "boolean" } } },
    },
    { ...closedSchema, patternProperties: { ".*": { type: "string" } } },
    { ...closedSchema, properties: { ok: { $ref: "#/unknown" } } },
  ])(
    "reports incompatible paths without changing accepted values: %j",
    (schema) => {
      const before = structuredClone(schema);
      const checked = checkStrictToolSchema(schema, strictProfile);
      expect(checked.compatible).toBe(false);
      expect(checked.issues.length).toBeGreaterThan(0);
      expect(checked.issues.every((entry) => entry.path.startsWith("#"))).toBe(
        true,
      );
      expect(schema).toEqual(before);
    },
  );
  it("retains optional/open narrative values and returns bounded diagnostics", () => {
    const narrative = JSON.parse(
      readFileSync(
        new URL(
          "../../../plugins/narrator/schemas/narrative-engine.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const before = JSON.stringify(narrative);
    const checked = checkStrictToolSchema(narrative, strictProfile);
    expect(checked.compatible).toBe(false);
    expect(checked.issues).toContainEqual(
      expect.objectContaining({ reason: "profile requires a closed object" }),
    );
    expect(checked.issues.length).toBeLessThanOrEqual(8);
    expect(checked.issues.every((entry) => entry.path.length <= 200)).toBe(
      true,
    );
    expect(JSON.stringify(narrative)).toBe(before);
  });
  it.each([
    { maxBytes: 20 },
    { maxDepth: 1 },
    { maxProperties: 0 },
    { maxEnumValues: 0 },
  ])("checks profile size limits: %j", (limits) => {
    expect(
      checkStrictToolSchema(
        {
          ...closedSchema,
          properties: { ok: { type: "boolean", enum: [true, false] } },
        },
        { ...strictProfile, ...limits },
      ).compatible,
    ).toBe(false);
  });
  it("honors explicitly supported constraints and union keywords", () => {
    const profile = {
      ...strictProfile,
      keywords: [...strictProfile.keywords, "anyOf", "minLength"] as const,
    };
    expect(
      checkStrictToolSchema(
        {
          ...closedSchema,
          properties: {
            ok: {
              anyOf: [{ type: "string", minLength: 1 }, { type: "boolean" }],
            },
          },
        },
        { ...profile, keywords: [...profile.keywords] },
      ).compatible,
    ).toBe(true);
  });
  it("checks local and recursive references against the selected profile", () => {
    const schema = {
      ...closedSchema,
      $defs: { flag: { type: "boolean" } },
      properties: { ok: { $ref: "#/$defs/flag" } },
    };
    const profile = {
      ...strictProfile,
      keywords: [...strictProfile.keywords, "$defs", "$ref"] as const,
    };
    expect(
      checkStrictToolSchema(schema, {
        ...profile,
        keywords: [...profile.keywords],
        references: "local",
      }).compatible,
    ).toBe(true);
    const recursive = { ...closedSchema, properties: { ok: { $ref: "#" } } };
    expect(
      checkStrictToolSchema(recursive, {
        ...profile,
        keywords: [...profile.keywords],
        references: "local",
      }).compatible,
    ).toBe(false);
    expect(
      checkStrictToolSchema(recursive, {
        ...profile,
        keywords: [...profile.keywords],
        references: "recursive",
      }).compatible,
    ).toBe(true);
  });
  it("requires an exact explicit target profile and only opts in marked tools", () => {
    const tools = [
      {
        type: "function" as const,
        strict: "auto" as const,
        function: { name: "submit-output", parameters: closedSchema },
      },
      {
        type: "function" as const,
        function: { name: "business", parameters: closedSchema },
      },
    ];
    expect(
      selectStrictTools(
        tools,
        strictCapability,
        strictCapability,
        false,
      ).tools?.map((tool) => tool.function.strict),
    ).toEqual([true, undefined]);
    for (const target of [
      { ...strictCapability, provider: "other" },
      { ...strictCapability, model: "other" },
      { ...strictCapability, protocol: "openai-responses-v1" },
      { ...strictCapability, baseUrl: "https://fixture.invalid/beta" },
    ])
      expect(
        selectStrictTools(tools, strictCapability, target, false).tools?.[0]
          ?.function.strict,
      ).toBe(false);
    expect(
      selectStrictTools(tools, undefined, strictCapability, false).tools?.[0]
        ?.function.strict,
    ).toBe(false);
  });
  it("retains host capability profiles through request restriction without inferring strict from JSON mode", () => {
    expect(
      resolveCapability("unknown", "fixture", "openai-chat-v1").strictTools,
    ).toBeUndefined();
    const base = resolveCapability("unknown", "fixture", "openai-chat-v1", {
      strictTools: strictCapability,
    });
    for (const policy of ["full", "restrict-only"] as const)
      expect(
        mergeRequestCapabilityOverride(
          base,
          { features: ["function_calling"] },
          policy,
        ).strictTools,
      ).toEqual(strictCapability);
    expect(
      strictToolCapabilitySchema.safeParse({
        ...strictCapability,
        profile: { ...strictProfile, maxDepth: 1000 },
      }).success,
    ).toBe(false);
  });
});
