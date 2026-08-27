import { describe, expect, it } from "vitest";
import {
  createGatewayAdapter,
  type GatewayLike,
} from "../src/llm/gateway-llm-adapter.js";

describe("createGatewayAdapter target resolution", () => {
  it("resolves the trace identity with the same request-scoped slot config", () => {
    const calls: Array<{
      slot: string | undefined;
      options: Parameters<GatewayLike["resolveSlot"]>[1];
    }> = [];
    const gateway: GatewayLike = {
      resolveSlot(slot, options) {
        calls.push({ slot, options });
        return { provider: "deepseek-proxy", model: "deepseek-chat" };
      },
      async generateText() {
        throw new Error("unused");
      },
    };
    const slotOverrides = {
      slotPresetOverrides: { story: "custom-story" },
    };
    const adapter = createGatewayAdapter(gateway, {
      apiKeys: { "deepseek-proxy": "request-key" },
      envApiKeys: { deepseek: "env-key" },
      slotOverrides,
      capabilityOverridePolicy: "restrict-only",
    });

    expect(adapter.resolveTarget?.("story")).toEqual({
      provider: "deepseek-proxy",
      model: "deepseek-chat",
    });
    expect(calls).toEqual([
      {
        slot: "story",
        options: {
          apiKeys: { "deepseek-proxy": "request-key" },
          envApiKeys: { deepseek: "env-key" },
          slotOverrides,
          capabilityOverridePolicy: "restrict-only",
          fallbackTag: "text",
        },
      },
    ]);
  });

  it("returns undefined when slot resolution fails", () => {
    const gateway: GatewayLike = {
      resolveSlot() {
        throw new Error("preset not found");
      },
      async generateText() {
        throw new Error("unused");
      },
    };
    const adapter = createGatewayAdapter(gateway);

    expect(adapter.resolveTarget?.("missing")).toBeUndefined();
  });

  it("forwards the per-call target observer into the gateway", async () => {
    let gatewayObserver:
      ((target: { provider: string; model: string }) => void) | undefined;
    const gateway: GatewayLike = {
      resolveSlot() {
        return { provider: "primary", model: "primary-model" };
      },
      async generateText(_input, options) {
        gatewayObserver = options?.onTargetAttempt;
        gatewayObserver?.({ provider: "backup", model: "backup-model" });
        return {
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const adapter = createGatewayAdapter(gateway);
    const observed: Array<{ provider: string; model: string }> = [];

    await adapter.generate({
      messages: [{ role: "user", content: "hi" }],
      onTargetAttempt: (target) => observed.push(target),
    });

    expect(gatewayObserver).toBeTypeOf("function");
    expect(observed).toEqual([{ provider: "backup", model: "backup-model" }]);
  });

  it("preserves prompt cache usage from the gateway", async () => {
    const gateway: GatewayLike = {
      resolveSlot() {
        return { provider: "openai", model: "gpt-test" };
      },
      async generateText() {
        return {
          text: "ok",
          finishReason: "stop",
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cachedInputTokens: 80,
            cacheWriteInputTokens: 20,
          },
        };
      },
    };

    const result = await createGatewayAdapter(gateway).generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 20,
    });
  });

  it("preserves prompt cache usage from a streamed gateway done event", async () => {
    const gateway: GatewayLike = {
      resolveSlot() {
        return { provider: "anthropic", model: "claude-test" };
      },
      async generateText() {
        throw new Error("unused");
      },
      async *streamText() {
        yield {
          type: "done",
          finishReason: "stop",
          usage: {
            inputTokens: 40,
            outputTokens: 4,
            cachedInputTokens: 30,
            cacheWriteInputTokens: 10,
          },
        };
      },
    };

    const events = [];
    for await (const event of createGatewayAdapter(gateway).stream!({
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "done",
        finishReason: "stop",
        usage: {
          inputTokens: 40,
          outputTokens: 4,
          cachedInputTokens: 30,
          cacheWriteInputTokens: 10,
        },
      },
    ]);
  });
});
