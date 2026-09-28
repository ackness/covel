import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createGateway } from "../src/gateway.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

const partial = '{"count":1}';
const config = { baseUrl: "https://provider.example" };
const params = {
  model: "synthetic",
  messages: [],
  schema: z.object({ count: z.number() }),
};
const protocols = [
  {
    name: "chat",
    create: createOpenAiChatAdapter,
    payload: {
      error: { message: "Synthetic error" },
      choices: [{ message: { content: partial }, finish_reason: "stop" }],
    },
  },
  {
    name: "responses",
    create: createOpenAiResponsesAdapter,
    payload: {
      status: "failed",
      output: [
        { type: "message", content: [{ type: "output_text", text: partial }] },
      ],
    },
  },
  {
    name: "anthropic",
    create: createAnthropicMessagesAdapter,
    payload: {
      type: "error",
      error: { message: "Synthetic error" },
      content: [{ type: "text", text: partial }],
      stop_reason: "end_turn",
    },
  },
];
function stub(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)(
  "$name non-stream completion",
  ({ create, payload }) => {
    it.each(["generateText", "generateObject"] as const)(
      "rejects error payload before %s releases partial output",
      async (method) => {
        stub(payload);
        await expect(create()[method](config, params)).rejects.toMatchObject({
          code: "PROVIDER_ERROR",
        });
      },
    );
  },
);

it.each([undefined, "queued", "in_progress", "cancelled"])(
  "rejects a non-terminal Responses status %s",
  async (status) => {
    stub({
      status,
      output: [
        { type: "message", content: [{ type: "output_text", text: partial }] },
      ],
    });
    await expect(
      createOpenAiResponsesAdapter().generateText(config, params),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  },
);
it.each(["completed", "incomplete"])(
  "preserves Responses %s finish policy",
  async (status) => {
    stub({
      status,
      output: [
        { type: "message", content: [{ type: "output_text", text: partial }] },
      ],
    });
    await expect(
      createOpenAiResponsesAdapter().generateObject(config, params),
    ).resolves.toMatchObject({
      object: { count: 1 },
      finishReason: status === "completed" ? "stop" : "length",
    });
  },
);

it.each(["generateText", "generateObject"] as const)(
  "gates custom %s adapters before success telemetry and permits configured fallback",
  async (method) => {
    const success = vi.fn();
    const error = vi.fn();
    const adapter: ModelProviderAdapter = {
      async generateText() {
        return {
          text: partial,
          finishReason: "error",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateObject(_config, input) {
        return {
          object: input.schema.parse({ count: 1 }),
          finishReason: "error",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *streamText() {
        throw new Error("unused");
      },
      async embed() {
        throw new Error("unused");
      },
    };
    const backup: ModelProviderAdapter = {
      ...adapter,
      async generateText() {
        return {
          ...(await adapter.generateText(config, params)),
          text: "backup",
          finishReason: "stop",
        };
      },
      async generateObject(_config, input) {
        return {
          ...(await adapter.generateObject(config, input)),
          object: input.schema.parse({ count: 2 }),
          finishReason: "stop",
        };
      },
    };
    const providerRegistry = createProviderRegistry({
      providers: {
        primary: {
          adapter,
          defaults: config,
          hooks: [{ onRequestSuccess: success, onRequestError: error }],
        },
        backup: { adapter: backup, defaults: config },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles: [],
      presets: [
        {
          id: "primary",
          name: "Primary",
          provider: "primary",
          model: "synthetic",
          tier: "medium",
          enabled: true,
          isDefault: true,
          supportedModes: ["text", "object"],
          fallbackPresetIds: ["backup"],
        },
        {
          id: "backup",
          name: "Backup",
          provider: "backup",
          model: "synthetic",
          tier: "medium",
          enabled: true,
          supportedModes: ["text", "object"],
        },
      ],
    });
    const gateway = createGateway({ providerRegistry, presetRegistry });
    await expect(
      gateway[method](params, { allowFallback: false }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const result = await gateway[method](params);
    expect(result).toMatchObject({ provider: "backup", finishReason: "stop" });
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  },
);
