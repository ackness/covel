import { describe, it, expect } from "vitest";
import { createProviderRegistry } from "../src/provider-registry.js";
import { PROVIDER_PROTOCOLS } from "../src/types.js";
import { getProtocolDefinition } from "../src/protocol-registry.js";

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

    const result = registry.resolve({ provider: "deepseek" }, { mode: "text" });

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
      { mode: "text" },
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
      { mode: "text" },
    );

    expect(result.protocol).toBe("openai-responses-v1");
  });

  it("throws on unregistered provider", () => {
    const registry = createProviderRegistry();

    expect(() =>
      registry.resolve({ provider: "unknown" }, { mode: "text" }),
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
      { mode: "text" },
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
      { mode: "text" },
    );

    const withKeys = registry.withApiKeys(
      resolution,
      { deepseek: "sk-test-key" },
      "deepseek",
    );

    expect(withKeys.config.apiKey).toBe("sk-test-key");
    // Original should be unmodified
    expect(resolution.config.apiKey).toBeUndefined();
  });

  // ── S-01: env-key origin binding ────────────────────────────────

  describe("env-key origin binding (S-01)", () => {
    function makeRegistry() {
      return createProviderRegistry({
        providerDefaults: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      });
    }

    it("attaches env keys when the target keeps the trusted origin", () => {
      const registry = makeRegistry();
      const resolution = registry.resolve({ provider: "openai" });

      const withKeys = registry.withApiKeys(resolution, {}, "openai", {
        openai: "sk-env",
      });

      expect(resolution.envKeyAllowed).toBe(true);
      expect(withKeys.config.apiKey).toBe("sk-env");
    });

    it("refuses env keys when a request-scoped target redirects the origin", () => {
      const registry = makeRegistry();
      const resolution = registry.resolve({
        provider: "openai",
        baseUrl: "https://attacker.example",
        requestScoped: true,
      });

      const withKeys = registry.withApiKeys(resolution, {}, "openai", {
        openai: "sk-env",
      });

      expect(resolution.envKeyAllowed).toBe(false);
      expect(withKeys.config.apiKey).toBeUndefined();
      // The request travels to the attacker origin, just without the key.
      expect(withKeys.config.baseUrl).toBe("https://attacker.example");
    });

    it("still applies request-supplied keys to a redirected origin", () => {
      const registry = makeRegistry();
      const resolution = registry.resolve({
        provider: "openai",
        baseUrl: "https://my-proxy.example/v1",
        requestScoped: true,
      });

      const withKeys = registry.withApiKeys(
        resolution,
        { openai: "sk-user" },
        "openai",
        { openai: "sk-env" },
      );

      expect(withKeys.config.apiKey).toBe("sk-user");
    });

    it("allows env keys for a request-scoped target on the trusted origin", () => {
      const registry = makeRegistry();
      // e.g. a browser custom preset that only changes the model.
      const resolution = registry.resolve({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        requestScoped: true,
      });

      const withKeys = registry.withApiKeys(resolution, {}, "openai", {
        openai: "sk-env",
      });

      expect(resolution.envKeyAllowed).toBe(true);
      expect(withKeys.config.apiKey).toBe("sk-env");
    });

    it("refuses env keys for a request-scoped (overlay-registered) provider", () => {
      const registry = makeRegistry();
      // Fresh provider name registered from an untrusted request: its
      // defaults.baseUrl is attacker-controlled, so origin "matching" its
      // own registration must not unlock env keys.
      registry.addProvider(
        "groq",
        { baseUrl: "https://attacker.example" },
        { requestScoped: true },
      );
      const resolution = registry.resolve({ provider: "groq" });

      const withKeys = registry.withApiKeys(resolution, {}, "groq", {
        groq: "sk-env",
      });

      expect(resolution.envKeyAllowed).toBe(false);
      expect(withKeys.config.apiKey).toBeUndefined();
    });

    it("does not send trusted default headers to a redirected origin", () => {
      const registry = createProviderRegistry({
        providerDefaults: {
          custom: {
            baseUrl: "https://api.custom.example",
            headers: { "x-secret": "trusted-header-token" },
          },
        },
      });

      const trusted = registry.resolve({ provider: "custom" });
      expect(trusted.config.headers).toEqual({
        "x-secret": "trusted-header-token",
      });

      const redirected = registry.resolve({
        provider: "custom",
        baseUrl: "https://attacker.example",
        requestScoped: true,
      });
      expect(redirected.config.headers).toBeUndefined();
    });
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
      const result = registry.resolve({ provider: "openai" }, { mode: "text" });
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

  // ── ProtocolRegistry coverage (T9) ──────────────────────────────

  describe("ProtocolRegistry coverage", () => {
    it("registers an adapter + cacheStrategy + capabilityDefaults for every protocol", () => {
      for (const protocol of PROVIDER_PROTOCOLS) {
        const def = getProtocolDefinition(protocol);
        expect(def, `protocol "${protocol}" must be registered`).toBeDefined();
        // Each protocol bundles all three protocol-scoped concerns.
        expect(def?.createAdapter()).toBeDefined();
        expect(def?.cacheStrategy).toBeTruthy();
        expect(def?.capabilityDefaults.input.length).toBeGreaterThan(0);
        expect(def?.capabilityDefaults.output.length).toBeGreaterThan(0);
      }
    });

    it("resolves each protocol to a working adapter through the registry", () => {
      for (const protocol of PROVIDER_PROTOCOLS) {
        const registry = createProviderRegistry({
          providerDefaults: { p: { baseUrl: "https://x" } },
        });
        // Protocol flows through the resolve target (the preset path), the
        // same way the gateway routes it.
        const result = registry.resolve(
          { provider: "p", protocol },
          { mode: "text" },
        );
        expect(result.protocol).toBe(protocol);
        expect(result.adapter).toBeDefined();
        expect(result.config.cacheStrategy).toBe(
          getProtocolDefinition(protocol)?.cacheStrategy,
        );
      }
    });
  });
});
