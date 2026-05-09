import { describe, expect, it } from "vitest";
import type { PresetSummary } from "@/services/api.js";
import {
  defaultModelForProvider,
  emptyFormState,
  modelOptionsForProvider,
  providerOptionLabel,
} from "../provider-state.js";

const presets: PresetSummary[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    model: "deepseek-chat",
    enabled: true,
    isDefault: true,
    scope: "builtin",
  },
  {
    id: "deepseek-chat-duplicate",
    name: "DeepSeek Chat duplicate",
    provider: "deepseek",
    model: "deepseek-chat",
    enabled: true,
    isDefault: false,
    scope: "builtin",
  },
  {
    id: "deepseek-disabled",
    name: "DeepSeek Disabled",
    provider: "deepseek",
    model: "deepseek-reasoner",
    enabled: false,
    isDefault: false,
    scope: "builtin",
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: "openai",
    model: "gpt-4o",
    enabled: true,
    isDefault: false,
    scope: "builtin",
  },
];

describe("onboarding provider state helpers", () => {
  it("creates the default form state", () => {
    expect(emptyFormState()).toEqual({
      selected: "deepseek",
      apiKey: "",
      keyVisible: false,
      builtInModel: "",
      customBaseUrl: "",
      customModel: "",
      customProviderName: "",
    });
  });

  it("deduplicates enabled provider models in catalog order", () => {
    expect(modelOptionsForProvider(presets, "deepseek")).toEqual([
      "deepseek-chat",
    ]);
  });

  it("uses the first enabled model as the default", () => {
    expect(defaultModelForProvider(presets, "openai")).toBe("gpt-4o");
    expect(defaultModelForProvider(presets, "missing")).toBe("");
  });

  it("labels known providers and preserves unknown provider ids", () => {
    expect(providerOptionLabel("deepseek")).toBe("DeepSeek");
    expect(providerOptionLabel("local-ai")).toBe("local-ai");
  });
});
