import { describe, expect, it } from "vitest";
import {
  actionRequestSchema,
  apiListResponseSchema,
  apiErrorResponseSchema,
  pluginSummarySchema,
  sseEnvelopeSchema,
  validateActionRequest,
  worldCreateRequestSchema,
  worldPluginPlanSchema,
  worldWireRecordSchema,
} from "../src/schemas/api-contract.js";

describe("shared API contracts", () => {
  it("parses and narrows an action request", () => {
    const parsed = validateActionRequest({
      requestId: "req-1",
      sessionId: "session-1",
      type: "retry_runtime",
      locale: "EN_us",
      payload: { runtimeId: "plugin/story" },
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        requestId: "req-1",
        sessionId: "session-1",
        type: "retry_runtime",
        locale: "en-US",
        payload: { runtimeId: "plugin/story" },
      },
    });
  });

  it("rejects mismatched action types and payloads", () => {
    expect(
      actionRequestSchema.safeParse({
        requestId: "req-1",
        sessionId: "session-1",
        type: "send_message",
        payload: { command: "look" },
      }).success,
    ).toBe(false);
    expect(
      actionRequestSchema.safeParse({
        requestId: "req-2",
        sessionId: "session-1",
        type: "start_session",
      }).success,
    ).toBe(false);
  });

  it("validates the common error and SSE envelopes", () => {
    expect(
      apiErrorResponseSchema.parse({
        error: "Session is busy",
        code: "session_busy",
        details: { retry: true },
      }),
    ).toEqual({
      error: "Session is busy",
      code: "session_busy",
      details: { retry: true },
    });

    expect(
      sseEnvelopeSchema.safeParse({
        type: "runtime.completed",
        requestId: "req-1",
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        flowId: "trace-1",
        seq: -1,
        timestamp: "2026-09-04T00:00:00.000Z",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("keeps world create input and world response types distinct", () => {
    expect(worldCreateRequestSchema.parse({ name: "New World" })).toEqual({
      name: "New World",
    });
    expect(
      worldWireRecordSchema.safeParse({
        id: "world-1",
        name: { en: "World" },
        description: "Description",
        createdAt: "2026-09-04T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates canonical plugin discovery and world-plan responses", () => {
    const plugin = {
      id: "memory",
      displayName: "Memory",
      description: "Memory plugin",
      pluginType: "plugin",
      source: "builtin",
      status: "registered",
      runtimeCount: 1,
      capabilities: ["memory"],
      tags: [],
      runtimes: [
        {
          id: "memory",
          runtimeType: "agent",
          trigger: { type: "auto" },
          execution: "sync",
          turnCompletion: { mode: "await" },
          outputKind: "plugin",
          capabilities: ["memory"],
          tags: [],
        },
      ],
      tools: [],
      userSettings: [],
    };
    expect(
      apiListResponseSchema(pluginSummarySchema).parse({ items: [plugin] }),
    ).toEqual({ items: [plugin] });

    expect(
      worldPluginPlanSchema.safeParse({
        worldId: "world-1",
        packs: [],
        policy: {
          preferredTags: [],
          avoidedTags: [],
          requiredCapabilities: [],
          requiredPluginIds: [],
          recommendedPluginIds: [],
          excludedPluginIds: [],
        },
        defaultPluginIds: ["memory"],
      }).success,
    ).toBe(true);
  });
});
