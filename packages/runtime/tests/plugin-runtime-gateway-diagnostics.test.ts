import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMDiagnostics } from "@covel/shared";
import {
  createPluginRuntimeGateway,
  type FullGatewayLike,
} from "../src/function-runtime/plugin-runtime-gateway.js";
import { withGatewayTrace } from "../src/function-runtime/gateway-trace.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";

const diagnostics: LLMDiagnostics = {
  warnings: [{ type: "compatibility", message: "private warning detail" }],
  sources: [
    {
      type: "url",
      id: "source-1",
      url: "https://example.org/source?token=private-query",
      title: "private source title",
    },
  ],
  citations: [{ sourceId: "source-1", citedText: "private cited text" }],
};
const usage = { inputTokens: 1, outputTokens: 1 };

function trace(gateway: ReturnType<typeof createPluginRuntimeGateway>) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emitter: TurnEmitter = {
    sessionId: "synthetic-session",
    turnId: "synthetic-turn",
    async emit(type, payload) {
      events.push({ type, payload });
    },
  };
  return {
    events,
    gateway: withGatewayTrace(gateway, emitter, {
      sessionId: "synthetic-session",
      turnId: "synthetic-turn",
      pluginId: "synthetic-plugin",
      runtimeId: "synthetic-runtime",
    }),
  };
}

describe("function-runtime gateway diagnostics", () => {
  it("returns full text/object diagnostics and forwards namespaced provider options", async () => {
    const options = { "openai-chat-v1": { seed: 42 } };
    const received: unknown[] = [];
    const full: FullGatewayLike = {
      resolveSlot: () => null,
      async generateText(input) {
        received.push(input.providerOptions);
        return { text: "{}", finishReason: "stop", usage, diagnostics };
      },
      async generateObject(input) {
        received.push(input.providerOptions);
        return {
          object: input.schema.parse({ ok: true }),
          finishReason: "stop",
          usage,
          diagnostics,
        };
      },
    };
    const { gateway, events } = trace(
      createPluginRuntimeGateway(full, {
        toZodSchema: () => z.object({ ok: z.boolean() }),
      }),
    );
    const text = await gateway.generateText({
      prompt: "fixture",
      providerOptions: options,
    });
    const object = await gateway.generateObject({
      prompt: "fixture",
      schema: {},
      providerOptions: options,
    });
    expect(text.diagnostics).toBe(diagnostics);
    expect(object.diagnostics).toBe(diagnostics);
    expect(received).toEqual([options, options]);
    const responses = events.filter(
      (event) => event.type === "gateway.responded",
    );
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.payload.diagnosticsSummary).toEqual({
        warningTypes: ["compatibility"],
        sourceCount: 1,
        citationCount: 1,
      });
      expect(JSON.stringify(response.payload)).not.toContain("private");
    }
  });

  it("rethrows full refusal details while tracing only the refusal reason", async () => {
    const refusalDiagnostics: LLMDiagnostics = {
      ...diagnostics,
      refusal: { reason: "content-filter", message: "private refusal detail" },
    };
    const error = Object.assign(new Error("Provider refused generation"), {
      code: "REFUSAL",
      retriable: false,
      details: { diagnostics: refusalDiagnostics },
    });
    const full: FullGatewayLike = {
      resolveSlot: () => null,
      async generateText() {
        throw error;
      },
      async generateObject() {
        throw error;
      },
    };
    const { gateway, events } = trace(
      createPluginRuntimeGateway(full, {
        toZodSchema: () => z.object({}),
      }),
    );
    await expect(gateway.generateText({ prompt: "fixture" })).rejects.toBe(
      error,
    );
    await expect(
      gateway.generateObject({ schema: {}, prompt: "fixture" }),
    ).rejects.toBe(error);
    const failures = events.filter((event) => event.type === "gateway.failed");
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.payload.diagnosticsSummary).toEqual({
        warningTypes: ["compatibility"],
        sourceCount: 1,
        citationCount: 1,
        refusalReason: "content-filter",
      });
      expect(JSON.stringify(failure.payload)).not.toContain("private");
    }
  });
});
