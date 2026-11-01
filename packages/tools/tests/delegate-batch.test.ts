import { describe, expect, it } from "vitest";
import {
  delegateBatchTool,
  delegateBatchParametersSchema,
  delegateBatchEnvelopeSchema,
} from "../src/index.js";

const request = { target: { contract: "test.worker@1" }, brief: "A task" };
describe("delegate-batch", () => {
  it("advertises valid per-child schemas and preserves the write-staging barrier", () => {
    expect(
      delegateBatchParametersSchema.safeParse({ requests: [request] }).success,
    ).toBe(true);
    expect(delegateBatchTool.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { requests: { type: "array", minItems: 1, maxItems: 32 } },
    });
    expect(delegateBatchTool.annotations).toEqual({
      readOnly: false,
      stagesWrites: true,
      idempotent: false,
      concurrencySafe: false,
    });
  });
  it("validates the container independently from individual requests", () => {
    expect(
      delegateBatchEnvelopeSchema.safeParse({ requests: [null, request] })
        .success,
    ).toBe(true);
    expect(
      delegateBatchParametersSchema.safeParse({ requests: [null, request] })
        .success,
    ).toBe(false);
    for (const value of [
      { requests: [] },
      { requests: Array(33).fill(request) },
      { requests: [request], extra: true },
    ])
      expect(delegateBatchEnvelopeSchema.safeParse(value).success).toBe(false);
  });
});
