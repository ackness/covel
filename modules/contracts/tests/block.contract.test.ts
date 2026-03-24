import { describe, it } from "vitest";

import {
  BlockEnvelopeSchema,
  BlockResponseSchema
} from "../src/index.js";
import {
  expectSchemaAccepts,
  expectSchemaRejects
} from "./helpers.js";

describe("BlockEnvelopeSchema", () => {
  it("accepts the standard interactive block envelope", () => {
    expectSchemaAccepts(BlockEnvelopeSchema, {
      id: "blk_01",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_01",
        traceId: "tr_01",
        sessionId: "ses_01",
        turnId: "turn_01"
      },
      interaction: {
        requiresResponse: true,
        responseSchema: "schemas/blocks/choices.response.json",
        submitAs: "block_response",
        resumePolicy: "resume_current_flow"
      },
      data: {
        title: "下一步做什么？",
        options: [
          { id: "opt_a", label: "继续前进" },
          { id: "opt_b", label: "调查周围" }
        ]
      }
    });
  });

  it("rejects a block missing required envelope fields", () => {
    expectSchemaRejects(BlockEnvelopeSchema, {
      type: "choices",
      data: {}
    });
  });

  it("rejects an interactive block that omits response routing metadata", () => {
    expectSchemaRejects(BlockEnvelopeSchema, {
      id: "blk_02",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_01",
        traceId: "tr_01",
        sessionId: "ses_01",
        turnId: "turn_01"
      },
      interaction: {
        requiresResponse: true
      },
      data: {
        title: "下一步做什么？"
      }
    });
  });
});

describe("BlockResponseSchema", () => {
  it("accepts a user response linked back to the original block", () => {
    expectSchemaAccepts(BlockResponseSchema, {
      blockId: "blk_01",
      blockType: "choices",
      sessionId: "ses_01",
      turnId: "turn_01",
      response: {
        selected: "opt_a"
      }
    });
  });

  it("rejects a response missing block linkage fields", () => {
    expectSchemaRejects(BlockResponseSchema, {
      blockType: "choices",
      response: {
        selected: "opt_a"
      }
    });
  });
});
