import { describe, expect, it } from "vitest";

import { createObservability } from "../src/index.js";

describe("createObservability", () => {
  it("records app logs, audit logs, and traces in separate sinks", () => {
    const observability = createObservability();

    observability.recordAppLog({
      level: "info",
      message: "request started",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      payload: {
        component: "runtime"
      }
    });
    observability.recordAuditLog({
      action: "archive.restore",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      actorId: "user_01",
      payload: {
        archiveVersionId: "arc_01"
      }
    });
    observability.recordTrace({
      traceId: "tr_01",
      spanId: "sp_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      component: "flow-engine",
      eventType: "model.completed",
      payload: {
        provider: "dashscope"
      },
      createdAt: "2026-03-24T12:00:00.000Z"
    });

    expect(observability.listAppLogs()).toHaveLength(1);
    expect(observability.listAuditLogs()).toHaveLength(1);
    expect(observability.listTracesByTraceId("tr_01")).toHaveLength(1);
  });

  it("redacts sensitive keys while preserving correlation ids", () => {
    const observability = createObservability();

    observability.recordTrace({
      traceId: "tr_02",
      spanId: "sp_02",
      sessionId: "ses_02",
      turnId: "turn_02",
      component: "model-gateway",
      eventType: "provider.request",
      payload: {
        apiKey: "secret-key",
        authorization: "Bearer secret",
        nested: {
          api_key: "nested-secret"
        }
      },
      createdAt: "2026-03-24T12:00:00.000Z"
    });

    expect(observability.listTracesByTraceId("tr_02")).toEqual([
      {
        traceId: "tr_02",
        spanId: "sp_02",
        sessionId: "ses_02",
        turnId: "turn_02",
        component: "model-gateway",
        eventType: "provider.request",
        payload: {
          apiKey: "[REDACTED]",
          authorization: "[REDACTED]",
          nested: {
            api_key: "[REDACTED]"
          }
        },
        createdAt: "2026-03-24T12:00:00.000Z"
      }
    ]);
  });
});
