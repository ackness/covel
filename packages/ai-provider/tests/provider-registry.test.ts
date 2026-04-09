import { describe, it, expect } from "vitest";
import { createProviderRegistry } from "../src/provider-registry.js";

describe("provider-registry", () => {
  it("resolves a registered provider with defaults", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-v1",
        },
      },
    });

    const result = registry.resolve(
      { provider: "deepseek" },
      { mode: "text" }
    );

    expect(result.protocol).toBe("openai-chat-v1");
    expect(result.config.baseUrl).toBe("https://api.deepseek.com");
    expect(result.adapter).toBeDefined();
  });

  it("auto-detects anthropic protocol", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        anthropic: {
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    });

    const result = registry.resolve(
      { provider: "anthropic" },
      { mode: "text" }
    );

    expect(result.protocol).toBe("anthropic-messages-v1");
  });

  it("respects explicit protocol override", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        custom: {
          baseUrl: "https://custom.api.com",
          protocol: "openai-responses-v1",
        },
      },
    });

    const result = registry.resolve(
      { provider: "custom", protocol: "openai-responses-v1" },
      { mode: "text" }
    );

    expect(result.protocol).toBe("openai-responses-v1");
  });

  it("throws on unregistered provider", () => {
    const registry = createProviderRegistry();

    expect(() =>
      registry.resolve({ provider: "unknown" }, { mode: "text" })
    ).toThrow("not registered");
  });

  it("merges TOML defaults with target baseUrl", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        test: {
          baseUrl: "https://default.url",
          headers: { "x-custom": "yes" },
        },
      },
    });

    const result = registry.resolve(
      { provider: "test", baseUrl: "https://override.url" },
      { mode: "text" }
    );

    expect(result.config.baseUrl).toBe("https://override.url");
    expect(result.config.headers?.["x-custom"]).toBe("yes");
  });

  it("injects API keys via withApiKeys", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        deepseek: { baseUrl: "https://api.deepseek.com" },
      },
    });

    const resolution = registry.resolve(
      { provider: "deepseek" },
      { mode: "text" }
    );

    const withKeys = registry.withApiKeys(
      resolution,
      { deepseek: "sk-test-key" },
      "deepseek"
    );

    expect(withKeys.config.apiKey).toBe("sk-test-key");
    // Original should be unmodified
    expect(resolution.config.apiKey).toBeUndefined();
  });
});
