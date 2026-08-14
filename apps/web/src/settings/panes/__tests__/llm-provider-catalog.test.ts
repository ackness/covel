import { describe, expect, it } from "vitest";
import {
  buildProviderCatalog,
  parseModelIds,
  sanitizeImportedProfile,
  sanitizeImportedProfiles,
} from "../llm-provider-catalog.js";

describe("provider catalogue", () => {
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
