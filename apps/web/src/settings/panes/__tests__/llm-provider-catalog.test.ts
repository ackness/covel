import { describe, expect, it } from "vitest";
import {
  bindFirstProviderModel,
  buildProviderCatalog,
  normalizeProviderId,
  normalizeProviderProfiles,
  parseModelIds,
  sanitizeImportedProfile,
  sanitizeImportedProfiles,
} from "../llm-provider-catalog.js";

describe("provider catalogue", () => {
  it("binds the first manually created model to story and plugin", () => {
    expect(bindFirstProviderModel({}, [], "model_first", [], [])).toEqual({
      story: { modelRef: "model_first" },
      plugin: { modelRef: "model_first" },
    });
  });

  it("preserves explicit bindings and skips later provider models", () => {
    expect(
      bindFirstProviderModel(
        { story: { modelRef: "existing" } },
        [],
        "model_first",
        [],
        [],
      ),
    ).toEqual({
      story: { modelRef: "existing" },
      plugin: { modelRef: "model_first" },
    });
    expect(
      bindFirstProviderModel(
        {},
        [
          {
            id: "existing",
            name: "Existing",
            baseUrl: "https://example.com",
            models: [{ ref: "old", modelId: "old" }],
          },
        ],
        "model_second",
        [],
        [],
      ),
    ).toEqual({});
  });

  it("preserves explicit server assignments for each core slot", () => {
    const serverPreset = {
      id: "server-story",
      name: "Server story",
      provider: "openai",
      model: "gpt-5",
      enabled: true,
      isDefault: true,
      scope: "server" as const,
      slotBindings: ["story", "plugin"],
    };

    expect(
      bindFirstProviderModel({}, [], "model_first", [serverPreset], []),
    ).toEqual({});
    expect(
      bindFirstProviderModel({}, [], "model_first", [], ["story"]),
    ).toEqual({ plugin: { modelRef: "model_first" } });
  });

  it("auto-binds core slots when server config only covers other roles", () => {
    const imagePreset = {
      id: "server-image",
      name: "Server image",
      provider: "openai",
      model: "gpt-image-1",
      enabled: true,
      isDefault: true,
      scope: "server" as const,
      slotBindings: ["image"],
    };

    expect(
      bindFirstProviderModel({}, [], "model_first", [imagePreset], ["image"]),
    ).toEqual({
      story: { modelRef: "model_first" },
      plugin: { modelRef: "model_first" },
    });
  });

  it("uses the persisted provider-id normalization for catalogue identity", () => {
    expect(normalizeProviderId(" OpenAI_API ")).toBe("openai-api");

    const profiles = normalizeProviderProfiles([
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        models: [{ ref: "gpt", modelId: "gpt-5" }],
      },
      {
        id: "OpenAI",
        name: "Duplicate spelling",
        baseUrl: "https://duplicate.example/v1",
        models: [{ ref: "mini", modelId: "gpt-5-mini" }],
      },
    ]);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [
        { ref: "gpt", modelId: "gpt-5" },
        { ref: "mini", modelId: "gpt-5-mini" },
      ],
    });
    expect(
      buildProviderCatalog(
        [
          {
            id: "slot-story",
            name: "Story",
            provider: "OpenAI",
            model: "gpt-5",
            enabled: true,
            isDefault: true,
            scope: "server",
          },
        ],
        profiles,
      ),
    ).toHaveLength(1);
  });

  it("keeps a migrated connection id separate from its key namespace", () => {
    const catalog = buildProviderCatalog(
      [],
      [
        {
          id: "openai-second-connection",
          provider: "OpenAI",
          name: "OpenAI proxy",
          baseUrl: "https://proxy.example/v1",
          models: [{ ref: "proxy-gpt", modelId: "gpt-5" }],
        },
      ],
    );

    expect(catalog[0]).toMatchObject({
      id: "openai-second-connection",
      provider: "openai",
      localProfile: {
        id: "openai-second-connection",
        provider: "openai",
      },
    });
  });

  it("merges llm.toml and local models under one provider", () => {
    const catalog = buildProviderCatalog(
      [
        {
          id: "slot-story",
          name: "Story",
          provider: "openai",
          model: "openai/gpt-5.6-sol",
          enabled: true,
          isDefault: true,
          scope: "server",
          baseUrl: "https://openai.example/v1",
          protocol: "openai-chat-v1",
        },
      ],
      [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://openai.example/v1",
          protocol: "openai-chat-v1",
          models: [
            {
              ref: "model-deepseek",
              modelId: "deepseek/deepseek-v4-flash",
            },
          ],
        },
      ],
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.serverModels[0]?.model).toBe("openai/gpt-5.6-sol");
    expect(catalog[0]?.localProfile?.models[0]?.modelId).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("parses bulk model IDs without rewriting and removes duplicates", () => {
    expect(
      parseModelIds(
        "openai/gpt-5.6-sol\ndeepseek/deepseek-v4-flash, openai/gpt-5.6-sol",
      ),
    ).toEqual(["openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"]);
  });

  it("clamps untrusted imported profiles to http(s) URLs and bounded lengths", () => {
    expect(
      sanitizeImportedProfile({
        id: " openai ",
        name: "x".repeat(500),
        baseUrl: "file:///etc/passwd",
        models: [{ ref: " m1 ", modelId: " gpt-5.6-sol " }],
      }),
    ).toEqual({
      id: "openai",
      name: "x".repeat(100),
      baseUrl: "",
      models: [{ ref: "m1", modelId: "gpt-5.6-sol" }],
    });
  });

  it("truncates over-long import fields and drops unusable models", () => {
    const sanitized = sanitizeImportedProfile({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://openai.example/v1",
      models: [
        { ref: "y".repeat(300), modelId: "m".repeat(500) },
        { ref: "blank", modelId: "   " },
      ],
    });
    expect(sanitized?.models).toEqual([
      { ref: "y".repeat(100), modelId: "m".repeat(200) },
    ]);
  });

  it("rejects imports without an id or with no surviving models", () => {
    expect(
      sanitizeImportedProfile({ id: "  ", name: "", baseUrl: "", models: [] }),
    ).toBeNull();
    expect(
      sanitizeImportedProfile({
        id: "openai",
        name: "OpenAI",
        baseUrl: "",
        models: [{ ref: "  ", modelId: "" }],
      }),
    ).toBeNull();
  });

  it("keeps valid v2 profiles when neighbouring entries or models are malformed", () => {
    expect(
      sanitizeImportedProfiles([
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://openai.example/v1",
          models: [
            { ref: "gpt", modelId: "gpt-5.6-sol" },
            { ref: 42, modelId: "invalid" },
          ],
        },
        { invalid: true },
      ]),
    ).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://openai.example/v1",
        models: [{ ref: "gpt", modelId: "gpt-5.6-sol" }],
      },
    ]);
  });

  it("drops unsupported or non-string protocol values from imports", () => {
    const base = {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://openai.example/v1",
      models: [{ ref: "gpt", modelId: "gpt-5.6-sol" }],
    };

    expect(
      sanitizeImportedProfile({ ...base, protocol: "unknown-wire" }),
    ).toEqual(base);
    expect(
      sanitizeImportedProfile({ ...base, protocol: { arbitrary: true } }),
    ).toEqual(base);
  });
});
