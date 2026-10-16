import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  listBuiltinProviderConnections,
  getBuiltinProviderConnection,
  isAccountFailure,
} from "@covel/shared";
import {
  classifyProviderFailure,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "../src/index.js";
import type { GatewayOptions } from "../src/gateway-slot-resolution.js";
import type { PresetConfig, ProviderConfig } from "../src/types.js";

const preset = (
  provider: string,
  extra: Partial<PresetConfig> = {},
): PresetConfig => ({
  id: "primary",
  name: "Primary",
  provider,
  model: "fixture-model",
  tier: "medium",
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  ...extra,
});
const input = { messages: [{ role: "user" as const, content: "Hello" }] };
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { stream?: boolean };
  if (body.stream)
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function gatewayFor(presets: PresetConfig[], defaults?: ProviderConfig) {
  return createGateway({
    providerRegistry: createProviderRegistry({
      providers: {
        custom: { defaults: { baseUrl: "https://gateway.example/v1" } },
        ...(defaults
          ? {
              deepseek: {
                defaults: {
                  ...getBuiltinProviderConnection("deepseek"),
                  ...defaults,
                },
              },
            }
          : {}),
      },
    }),
    presetRegistry: createPresetRegistry({ profiles: [], presets }),
  });
}

describe.each(["text", "object", "stream"] as const)(
  "%s effective provider credentials",
  (mode) => {
    async function run(
      gateway: ReturnType<typeof createGateway>,
      options?: GatewayOptions,
    ) {
      if (mode === "text") return gateway.generateText(input, options);
      if (mode === "object")
        return gateway.generateObject(
          { ...input, schema: z.object({ ok: z.boolean() }) },
          options,
        );
      const events = [];
      for await (const event of gateway.streamText(input, options))
        events.push(event);
      return events;
    }

    it("fails before fetch and classifies a missing built-in key as an account failure", async () => {
      const gateway = gatewayFor([preset("deepseek")]);
      const error: unknown = await run(gateway).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        code: "MISSING_API_KEY",
        provider: "deepseek",
        model: "fixture-model",
        retriable: false,
        statusCode: undefined,
      });
      expect(String(error)).toContain("No API key for DeepSeek");
      expect(classifyProviderFailure(error).kind).toBe("missing_key");
      expect(isAccountFailure(classifyProviderFailure(error).kind)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["request", "env", "config", "header"])(
      "sends when credentials come from %s",
      async (source) => {
        const gateway = gatewayFor(
          [preset("deepseek")],
          source === "config"
            ? { apiKey: "fixture-key" }
            : source === "header"
              ? { headers: { Authorization: "Bearer fixture-key" } }
              : undefined,
        );
        await run(
          gateway,
          source === "request"
            ? { apiKeys: { deepseek: "fixture-key" } }
            : source === "env"
              ? { envApiKeys: { deepseek: "fixture-key" } }
              : undefined,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
        expect(headers.get("authorization")).toBe("Bearer fixture-key");
      },
    );

    it.each([
      ["custom", "https://gateway.example/v1"],
      ["ollama", undefined],
      ["deepseek", "http://localhost:8080/v1"],
    ])("still sends without a key to %s at %s", async (provider, baseUrl) => {
      await run(
        gatewayFor([
          preset(provider!, { baseUrl, protocol: "openai-chat-v1" }),
        ]),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"),
      ).toBeNull();
    });

    it("skips backups sharing the missing key and tries a configured independent provider", async () => {
      const onTargetAttempt = vi.fn();
      const gateway = gatewayFor([
        preset("deepseek", { fallbackPresetIds: ["duplicate", "local"] }),
        preset("deepseek", {
          id: "duplicate",
          model: "other-model",
          isDefault: false,
        }),
        preset("ollama", { id: "local", isDefault: false }),
      ]);
      await run(gateway, { onTargetAttempt });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        onTargetAttempt.mock.calls.map(([target]) => target.provider),
      ).toEqual(["deepseek", "ollama"]);
    });
  },
);

it.each(listBuiltinProviderConnections().filter((provider) => !provider.local))(
  "requires credentials for built-in remote $id",
  async ({ id, label }) => {
    await expect(gatewayFor([preset(id)]).generateText(input)).rejects.toThrow(
      `No API key for ${label}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("does not treat whitespace as a key", async () => {
  await expect(
    gatewayFor([preset("deepseek")]).generateText(input, {
      apiKeys: { deepseek: "  " },
    }),
  ).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  expect(fetchMock).not.toHaveBeenCalled();
});
