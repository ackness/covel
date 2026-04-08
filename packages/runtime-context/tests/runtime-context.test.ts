import { describe, it, expect } from "vitest";
import { assemblePrompt } from "../src/prompt-assembler.js";
import { parseStructuredOutput, validateJsonSchema } from "../src/structured-output.js";
import {
  successResult,
  failedResult,
  approvalDeniedResult,
  skippedConditionResult,
  skippedLimitResult,
  wrapAsPublishedRecord,
} from "../src/failure.js";

describe("assemblePrompt", () => {
  it("should assemble prompt in correct order", () => {
    const result = assemblePrompt({
      pluginPrompt: "You are a dice roller plugin.",
      instructions: "Roll dice when asked.",
      locale: "zh-CN",
      toolDefinitions: [
        { qualifiedId: "kernel:write_table", description: "Write to table" },
      ],
      contextSections: [
        { title: "world", content: "A dark forest.", priority: 10 },
        { title: "character", content: "HP: 50", priority: 20 },
      ],
    });

    expect(result.sections).toHaveLength(6);
    expect(result.sections[0].label).toBe("plugin-prompt");
    expect(result.sections[1].label).toBe("instructions");
    expect(result.sections[2].label).toBe("locale");
    // Higher priority context first
    expect(result.sections[3].label).toBe("context:character");
    expect(result.sections[4].label).toBe("context:world");
    expect(result.sections[5].label).toBe("tools");
    expect(result.systemPrompt).toContain("zh-CN");
    expect(result.systemPrompt).toContain("dice roller");
  });

  it("should handle minimal input", () => {
    const result = assemblePrompt({ locale: "en-US" });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].label).toBe("locale");
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      hp: { type: "integer" },
    },
    required: ["name", "hp"],
  };

  it("should validate correct data", () => {
    const result = validateJsonSchema({ name: "Hero", hp: 100 }, schema);
    expect(result.valid).toBe(true);
  });

  it("should reject missing required fields", () => {
    const result = validateJsonSchema({ name: "Hero" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: hp");
  });

  it("should reject wrong types", () => {
    const result = validateJsonSchema({ name: "Hero", hp: "not-a-number" }, schema);
    expect(result.valid).toBe(false);
  });

  it("should reject non-objects when expecting object", () => {
    const result = validateJsonSchema("string", schema);
    expect(result.valid).toBe(false);
  });

  it("should enforce enum values", () => {
    const result = validateJsonSchema(
      { name: "Hero", hp: 100, tier: "legendary" },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          hp: { type: "integer" },
          tier: { type: "string", enum: ["common", "rare", "epic"] },
        },
        required: ["name", "hp", "tier"],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tier"))).toBe(true);
  });

  it("should reject additional properties when disabled", () => {
    const result = validateJsonSchema(
      { name: "Hero", hp: 100, extra: true },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          hp: { type: "integer" },
        },
        required: ["name", "hp"],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("extra"))).toBe(true);
  });

  it("should validate nested objects and arrays", () => {
    const result = validateJsonSchema(
      {
        total: 10,
        rolls: [6, "3", 1],
        meta: { tier: "rare", valid: "yes" },
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer" },
          rolls: {
            type: "array",
            items: { type: "integer" },
          },
          meta: {
            type: "object",
            additionalProperties: false,
            properties: {
              tier: { type: "string", enum: ["common", "rare", "epic"] },
              valid: { type: "boolean" },
            },
            required: ["tier", "valid"],
          },
        },
        required: ["total", "rolls", "meta"],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rolls"))).toBe(true);
    expect(result.errors.some((e) => e.includes("meta.valid"))).toBe(true);
  });
});

describe("parseStructuredOutput", () => {
  const config = {
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer" },
        rolls: { type: "array" },
      },
      required: ["total", "rolls"],
    },
  };

  it("should parse valid JSON", () => {
    const result = parseStructuredOutput(
      '{"total": 10, "rolls": [6, 3, 1]}',
      config,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ total: 10, rolls: [6, 3, 1] });
  });

  it("should extract JSON from markdown code block", () => {
    const result = parseStructuredOutput(
      'Here is the result:\n```json\n{"total": 7, "rolls": [4, 3]}\n```',
      config,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ total: 7, rolls: [4, 3] });
  });

  it("should fail on invalid JSON", () => {
    const result = parseStructuredOutput("This is not JSON.", config);
    expect(result.success).toBe(false);
  });

  it("should fail on schema validation error", () => {
    const result = parseStructuredOutput('{"total": "ten"}', config);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("failure helpers", () => {
  it("should create success result", () => {
    const r = successResult({ total: 10 });
    expect(r.status).toBe("success");
    expect(r.payload).toEqual({ total: 10 });
  });

  it("should create failed result", () => {
    const r = failedResult("timeout");
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("timeout");
  });

  it("should create approval_denied result", () => {
    const r = approvalDeniedResult();
    expect(r.status).toBe("approval_denied");
  });

  it("should create skipped_condition result", () => {
    const r = skippedConditionResult("no combat active");
    expect(r.status).toBe("skipped_condition");
  });

  it("should create skipped_limit result", () => {
    const r = skippedLimitResult("maxRunsPerTurn exceeded");
    expect(r.status).toBe("skipped_limit");
  });

  it("should wrap result as PublishedRecord", () => {
    const r = successResult({ total: 10 });
    const record = wrapAsPublishedRecord(r, {
      pluginId: "core-dice",
      runtimeId: "dice-roll",
      sessionId: "s1",
      turnId: "t1",
      runId: "run-1",
      traceId: "tr-1",
      locale: "zh-CN",
    });
    expect(record.recordType).toBe("runtime_result");
    expect(record.status).toBe("success");
    expect(record.pluginId).toBe("core-dice");
    expect(record.timestamp).toBeDefined();
  });
});
