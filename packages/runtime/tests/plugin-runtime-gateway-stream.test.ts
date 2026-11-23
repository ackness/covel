import { describe, expect, it } from "vitest";
import type { LLMDiagnostics } from "@covel/shared";
import {
  createPluginRuntimeGateway,
  withRuntimeTextDefaults,
  type FullGatewayLike,
} from "../src/function-runtime/plugin-runtime-gateway.js";

describe("PluginRuntimeGateway streamText and credentialSource projection", () => {
  it("streams text-delta, reasoning-delta, done (continuation + diagnostics), and forwards credentialSource", async () => {
    const usage = { inputTokens: 3, outputTokens: 4 };
    const diagnostics: LLMDiagnostics = {
      warnings: [{ type: "compatibility", message: "test warning" }],
    };
    const seen: Array<{
      presetId?: string;
      instructionLocale?: "en" | "zh";
      signalAborted?: boolean;
    }> = [];

    const full: FullGatewayLike = {
      resolveSlot(presetId) {
        return {
          presetId: presetId ?? "story",
          provider: "fake-plugin/sub",
          model: "sub-model",
          protocol: "openai-responses-v1",
          tag: "text",
          credentialSource: {
            sourceId: "fake-plugin/sub",
            accountId: "acct-1",
            ready: true,
          },
          metadata: {},
        };
      },
      async generateText() {
        return { text: "unused", finishReason: "stop", usage };
      },
      async generateObject(input) {
        return {
          object: input.schema.parse({ ok: true }),
          finishReason: "stop",
          usage,
        };
      },
      async *streamText(input, options) {
        seen.push({
          presetId: input.presetId,
          instructionLocale: input.instructionLocale,
          signalAborted: options?.signal?.aborted,
        });
        yield { type: "reasoning-delta", reasoningDelta: "plan " };
        yield { type: "text-delta", textDelta: "hello" };
        yield {
          type: "done",
          finishReason: "stop",
          usage,
          providerContinuation: {
            protocol: "openai-responses-v1",
            model: "sub-model",
            items: [{ type: "reasoning", id: "resp_stream_1" }],
          },
          diagnostics,
        };
      },
    };

    const facade = createPluginRuntimeGateway(full);
    expect(facade.resolveSlot({ presetId: "story" })).toEqual({
      presetId: "story",
      provider: "fake-plugin/sub",
      model: "sub-model",
      protocol: "openai-responses-v1",
      tag: "text",
      metadata: {},
      credentialSource: {
        sourceId: "fake-plugin/sub",
        accountId: "acct-1",
        ready: true,
      },
    });

    const controller = new AbortController();
    const withDefaults = withRuntimeTextDefaults(
      facade,
      "zh-CN",
      "default-slot",
    );

    const events = [];
    for await (const event of withDefaults.streamText!({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })) {
      events.push(event);
    }

    expect(seen).toEqual([
      {
        presetId: "default-slot",
        instructionLocale: "zh",
        signalAborted: false,
      },
    ]);
    expect(events).toEqual([
      { type: "reasoning-delta", reasoningDelta: "plan " },
      { type: "text-delta", textDelta: "hello" },
      {
        type: "done",
        finishReason: "stop",
        usage,
        providerContinuation: {
          protocol: "openai-responses-v1",
          model: "sub-model",
          items: [{ type: "reasoning", id: "resp_stream_1" }],
        },
        diagnostics,
      },
    ]);
  });
});
