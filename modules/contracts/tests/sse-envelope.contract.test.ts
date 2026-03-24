import { describe, it } from "vitest";

import { SseEnvelopeSchema } from "../src/index.js";
import {
  expectSchemaAccepts,
  expectSchemaRejects
} from "./helpers.js";

describe("SseEnvelopeSchema", () => {
  it("accepts the standard SSE json envelope", () => {
    expectSchemaAccepts(SseEnvelopeSchema, {
      type: "message.delta",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 12,
      timestamp: "2026-03-24T12:00:00Z",
      payload: {}
    });
  });

  it("accepts terminal flow events", () => {
    expectSchemaAccepts(SseEnvelopeSchema, {
      type: "flow.completed",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 13,
      timestamp: "2026-03-24T12:00:01Z",
      payload: {
        outcome: "ok"
      }
    });
  });

  it("rejects envelopes missing required correlation ids", () => {
    expectSchemaRejects(SseEnvelopeSchema, {
      type: "message.delta",
      requestId: "req_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 12,
      timestamp: "2026-03-24T12:00:00Z",
      payload: {}
    });
  });

  it("rejects non-integer sequence numbers", () => {
    expectSchemaRejects(SseEnvelopeSchema, {
      type: "message.delta",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 12.5,
      timestamp: "2026-03-24T12:00:00Z",
      payload: {}
    });
  });
});
