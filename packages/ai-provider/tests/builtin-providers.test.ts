import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDER_CONNECTIONS } from "@covel/shared";

import {
  buildProviderUrl,
  validateBaseUrl,
} from "../src/adapters/http/url-safety.js";
import { parseLlmConfig } from "../src/index.js";

describe("built-in provider endpoints", () => {
  it("builds the chat URL under each OpenAI Chat provider's own version path", () => {
    for (const [id, connection] of Object.entries(
      BUILTIN_PROVIDER_CONNECTIONS,
    )) {
      expect(validateBaseUrl(connection.baseUrl), id).toBe(true);
      if (connection.protocol !== "openai-chat-v1") continue;
      const versioned = /\/v\d[a-z0-9]*$/.test(connection.baseUrl)
        ? connection.baseUrl
        : `${connection.baseUrl}/v1`;
      expect(
        buildProviderUrl(connection.baseUrl, "/chat/completions"),
        id,
      ).toBe(`${versioned}/chat/completions`);
    }
  });
});

describe("llm.toml slots of a built-in provider", () => {
  it("takes the endpoint and protocol from the provider when the slot omits them", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "anthropic"
model = "claude-sonnet-5"
[covel.utility]
provider = "zhipu"
model = "glm-5"
`);
    expect(
      aiConfig.presets.map(({ provider, baseUrl, protocol }) => ({
        provider,
        baseUrl,
        protocol,
      })),
    ).toEqual([
      {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        protocol: "anthropic-messages-v1",
      },
      {
        provider: "zhipu",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        protocol: "openai-chat-v1",
      },
    ]);
  });

  it("keeps a stated endpoint and protocol", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "openai"
model = "gpt-6"
baseUrl = "https://proxy.example/v1"
protocol = "openai-responses-v1"
`);
    expect(aiConfig.presets[0]).toMatchObject({
      baseUrl: "https://proxy.example/v1",
      protocol: "openai-responses-v1",
    });
  });

  it("assumes OpenAI Chat for another provider and still needs its endpoint", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "my-proxy"
model = "some-model"
baseUrl = "https://proxy.example/v1"
`);
    expect(aiConfig.presets[0]?.protocol).toBe("openai-chat-v1");
    expect(() =>
      parseLlmConfig(`
[covel.story]
provider = "my-proxy"
model = "some-model"
`),
    ).toThrow(/baseUrl is required: .*my-proxy.* is not a built-in provider/);
  });
});
