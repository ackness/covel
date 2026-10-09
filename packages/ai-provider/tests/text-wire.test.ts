import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  parseLlmConfig,
  registerTextWire,
  type TextWire,
} from "../src/index.js";
import {
  getProtocolDefinition,
  listProtocolModels,
  listProviderProtocols,
} from "../src/protocol-registry.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A wire that answers with the model, endpoint and key it was given. */
function echoWire(overrides: Partial<TextWire> = {}): TextWire {
  return {
    id: "demo/echo",
    label: "Demo Echo",
    async generateText(config, params) {
      return {
        text: `${params.model}@${config.baseUrl}#${config.apiKey}`,
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async *streamText(_config, params) {
      yield { type: "text-delta", textDelta: params.model };
      yield {
        type: "done",
        finishReason: "max_tokens",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    ...overrides,
  };
}

function gatewayFor(toml: string) {
  const { aiConfig } = parseLlmConfig(toml);
  const slotRegistry = createSlotRegistry();
  slotRegistry.configure({
    slots: Object.fromEntries(
      aiConfig.presets.map((preset) => [
        preset.defaultSlot!,
        { slotId: preset.defaultSlot!, presetId: preset.id, tag: "text" },
      ]),
    ),
  });
  return createGateway({
    providerRegistry: createProviderRegistry({
      providerDefaults: aiConfig.providers,
    }),
    presetRegistry: createPresetRegistry(aiConfig),
    slotRegistry,
  });
}

const SLOT = `
[covel.story]
provider = "acme"
model    = "acme-1"
baseUrl  = "https://acme.example/v1"
protocol = "demo/echo"
`;

describe("a text protocol a plugin registers", () => {
  it("serves a slot that names it, with the slot's endpoint and the request's key", async () => {
    disposers.push(registerTextWire(echoWire()));
    const gateway = gatewayFor(SLOT);
    const options = { apiKeys: { acme: "request-key" } };

    const result = await gateway.generateText(
      { presetId: "story", messages: [{ role: "user", content: "hi" }] },
      options,
    );
    expect(result).toMatchObject({
      text: "acme-1@https://acme.example/v1#request-key",
      // The wire may answer in its provider's own word.
      finishReason: "stop",
      rawFinishReason: "end_turn",
    });

    const events = [];
    for await (const event of gateway.streamText(
      { presetId: "story", messages: [{ role: "user", content: "hi" }] },
      options,
    ))
      events.push(event);
    expect(events).toMatchObject([
      { type: "text-delta", textDelta: "acme-1" },
      { type: "done", finishReason: "length", rawFinishReason: "max_tokens" },
    ]);
  });

  it("answers an object call through generateText and checks the schema", async () => {
    let seen: unknown;
    disposers.push(
      registerTextWire(
        echoWire({
          async generateText(_config, params) {
            seen = params;
            return {
              text: '{"name":"Ada"}',
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }),
      ),
    );
    const gateway = gatewayFor(SLOT);
    const schema = z.object({ name: z.string() });

    const result = await gateway.generateObject({
      presetId: "story",
      schema,
      messages: [{ role: "user", content: "who" }],
    });

    expect(result.object).toEqual({ name: "Ada" });
    expect(seen).toMatchObject({ responseFormat: { type: "json_schema" } });
    expect(seen).not.toHaveProperty("schema");
    await expect(
      gateway.generateObject({
        presetId: "story",
        schema: z.object({ age: z.number() }),
        messages: [{ role: "user", content: "who" }],
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("is listed for the settings UI and lists its models when it can", async () => {
    disposers.push(
      registerTextWire(echoWire({ listModels: async () => ["acme-1"] })),
    );
    expect(listProviderProtocols().at(-1)).toEqual({
      id: "demo/echo",
      label: "Demo Echo",
      output: "text",
    });
    expect(
      await listProtocolModels("demo/echo", { baseUrl: "https://x" }, "acme"),
    ).toEqual(["acme-1"]);
  });

  it("fails a slot whose plugin is not loaded, and stops when the wire is removed", async () => {
    const gateway = gatewayFor(SLOT);
    const call = () =>
      gateway.generateText({
        presetId: "story",
        messages: [{ role: "user", content: "hi" }],
      });
    await expect(call()).rejects.toThrow(/protocol "demo\/echo" not supported/);

    const dispose = registerTextWire(echoWire());
    await expect(call()).resolves.toMatchObject({ finishReason: "stop" });
    dispose();
    expect(getProtocolDefinition("demo/echo")).toBeUndefined();
    await expect(call()).rejects.toThrow(/not supported/);
  });

  it("accepts only a built-in protocol or the plugin ID form in llm.toml", () => {
    expect(() =>
      parseLlmConfig(SLOT.replace('"demo/echo"', '"made-up-v1"')),
    ).toThrow(/Unknown protocol/);
  });
});
