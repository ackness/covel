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

  // ── S2-T3: cacheStrategy auto-fill ──────────────────────────────

  describe("cacheStrategy auto-fill (S2-T3)", () => {
    it("fills 'anthropic-explicit' for the anthropic protocol", () => {
      const registry = createProviderRegistry({
        providerDefaults: {
          anthropic: { baseUrl: "https://api.anthropic.com/v1" },
        },
      });
      const result = registry.resolve(
        { provider: "anthropic" },
        { mode: "text" },
      );
      expect(result.config.cacheStrategy).toBe("anthropic-explicit");
    });

    it("fills 'auto-prefix' for openai-chat-v1", () => {
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
        { mode: "text" },
      );
      expect(result.config.cacheStrategy).toBe("auto-prefix");
    });

    it("fills 'auto-prefix' for openai-responses-v1", () => {
      const registry = createProviderRegistry({
        providerDefaults: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            protocol: "openai-responses-v1",
          },
        },
      });
      const result = registry.resolve(
        { provider: "openai" },
        { mode: "text" },
      );
      expect(result.config.cacheStrategy).toBe("auto-prefix");
    });

    it("honors an explicit cacheStrategy override on the provider defaults", () => {
      const registry = createProviderRegistry({
        providers: {
          anthropic: {
            defaults: {
              baseUrl: "https://api.anthropic.com/v1",
              // Pin to "none" even though anthropic would otherwise get
              // 'anthropic-explicit' — lets downstream deployments disable
              // cache_control injection per-environment.
              cacheStrategy: "none",
            },
          },
        },
      });
      const result = registry.resolve(
        { provider: "anthropic" },
        { mode: "text" },
      );
      expect(result.config.cacheStrategy).toBe("none");
    });
  });
});
