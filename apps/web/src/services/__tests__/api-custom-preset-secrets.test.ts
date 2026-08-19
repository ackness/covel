/**
 * Regression test: custom preset API keys must live in the secrets
 * channel (`covel:keys`), NOT inline inside `llm.customPresets` / the
 * `covel:settings` blob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_STORAGE_KEYS_KEY,
  LOCAL_STORAGE_SETTINGS_KEY,
} from "@covel/settings";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    __dump: () => ({ ...store }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: false,
});

// Late import so the settings store sees the mocked localStorage.
const { getSettings, initSettings } = await import("@/settings/store");
const {
  getCustomPresets,
  getProviderPriceMultiplier,
  removeCustomPreset,
  setCustomPresets,
  setParamOverrides,
  setProviderProfiles,
  setProviderPriceMultipliers,
  setSlotConfig,
} = await import("../api.js");
const { buildProviderKeysHeader, buildSlotConfigHeaderInternal } =
  await import("../api/model-settings.js");

function readSettingsBlob(): Record<string, unknown> {
  const raw = localStorageMock.getItem(LOCAL_STORAGE_SETTINGS_KEY);
  if (!raw) return {};
  return JSON.parse(raw);
}

function readKeysBlob(): Record<string, string> {
  const raw = localStorageMock.getItem(LOCAL_STORAGE_KEYS_KEY);
  if (!raw) return {};
  return JSON.parse(raw);
}

beforeEach(async () => {
  localStorageMock.clear();
  await initSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom preset secret channel", () => {
  it("uses a 1x default and persists positive decimal provider multipliers", async () => {
    expect(getProviderPriceMultiplier("openai")).toBe(1);

    setProviderPriceMultipliers({ openai: 0.1, premium: 2.5, invalid: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getProviderPriceMultiplier("openai")).toBe(0.1);
    expect(getProviderPriceMultiplier("premium")).toBe(2.5);
    expect(getProviderPriceMultiplier("invalid")).toBe(1);
  });

  it("compiles a provider-first model reference without rewriting its model id", async () => {
    setProviderProfiles([
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://openai.example/v1",
        protocol: "openai-chat-v1",
        models: [
          {
            ref: "model_deepseek",
            modelId: "deepseek/deepseek-v4-flash",
          },
        ],
      },
    ]);
    setSlotConfig({ default: { modelRef: "model_deepseek" } });
    setParamOverrides({
      default: { temperature: 0.4, reasoningEffort: "max" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const encoded = buildSlotConfigHeaderInternal()["X-Slot-Config"];
    expect(encoded).toBeTruthy();
    const overlay = JSON.parse(atob(encoded!));
    expect(overlay.slotPresetOverrides).toEqual({
      default: "model_deepseek",
    });
    expect(overlay.parameterOverrides).toEqual({
      default: { temperature: 0.4, reasoningEffort: "max" },
    });
    expect(overlay.customPresets).toEqual([
      expect.objectContaining({
        id: "model_deepseek",
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
      }),
    ]);
  });

  it("strips apiKey from the settings blob and routes it to covel:keys", async () => {
    setCustomPresets([
      {
        id: "custom_x1",
        name: "My Qwen",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "qwen3.6-flash",
        protocol: "openai-chat-v1",
        apiKey: "sk-topsecret",
      },
    ]);
    // Settings writes are async — give the mocked backend a tick.
    await new Promise((r) => setTimeout(r, 0));

    const settings = readSettingsBlob() as {
      entries?: { "llm.customPresets"?: Array<Record<string, unknown>> };
    };
    const persisted = settings.entries?.["llm.customPresets"] ?? [];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(settings)).not.toContain("sk-topsecret");

    const keys = readKeysBlob();
    expect(keys["preset:custom_x1"]).toBe("sk-topsecret");
  });

  it("rehydrates apiKey from the secrets channel on read", async () => {
    setCustomPresets([
      {
        id: "custom_x1",
        name: "My Qwen",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "qwen3.6-flash",
        protocol: "openai-chat-v1",
        apiKey: "sk-topsecret",
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    const presets = getCustomPresets();
    expect(presets[0]?.apiKey).toBe("sk-topsecret");
  });

  it("clears the matching secret when the preset is removed", async () => {
    setCustomPresets([
      {
        id: "custom_x1",
        name: "My Qwen",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "qwen3.6-flash",
        protocol: "openai-chat-v1",
        apiKey: "sk-topsecret",
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    removeCustomPreset("custom_x1");
    await new Promise((r) => setTimeout(r, 0));

    const keys = readKeysBlob();
    expect(keys["preset:custom_x1"]).toBeUndefined();
  });

  it("clears only preset secrets no longer referenced by provider profiles", async () => {
    setCustomPresets([
      {
        id: "model_keep",
        name: "Keep",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "gpt-5",
        apiKey: "sk-keep",
      },
      {
        id: "model_remove",
        name: "Remove Model",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "gpt-4.1",
        apiKey: "sk-remove-model",
      },
      {
        id: "provider_remove",
        name: "Remove Provider",
        provider: "anthropic",
        baseUrl: "https://anthropic.example/v1",
        model: "claude-sonnet-4-6",
        apiKey: "sk-remove-provider",
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    setProviderProfiles([
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://openai.example/v1",
        models: [{ ref: "model_keep", modelId: "gpt-5" }],
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    const keys = readKeysBlob();
    expect(keys["preset:model_keep"]).toBe("sk-keep");
    expect(keys["preset:model_remove"]).toBeUndefined();
    expect(keys["preset:provider_remove"]).toBeUndefined();
  });

  it("routes distinct legacy connection keys through distinct provider namespaces", async () => {
    setCustomPresets([
      {
        id: "official_model",
        name: "Official",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        protocol: "openai-responses-v1",
        apiKey: "sk-official",
      },
      {
        id: "proxy_model",
        name: "Proxy",
        provider: "openai",
        baseUrl: "https://proxy.example/v1",
        model: "gpt-4.1",
        protocol: "openai-chat-v1",
        apiKey: "sk-proxy",
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    const presets = getCustomPresets();
    expect(new Set(presets.map((preset) => preset.provider)).size).toBe(2);

    const encoded = buildProviderKeysHeader()["X-Provider-Keys"];
    expect(encoded).toBeTruthy();
    const providerKeys = JSON.parse(atob(encoded!)) as Record<string, string>;
    expect(providerKeys[presets[0]!.provider]).toBe("sk-official");
    expect(providerKeys[presets[1]!.provider]).toBe("sk-proxy");

    await getSettings().set(`keys.${presets[1]!.provider}`, "sk-proxy-new");

    const updatedEncoded = buildProviderKeysHeader()["X-Provider-Keys"];
    const updatedProviderKeys = JSON.parse(atob(updatedEncoded!)) as Record<
      string,
      string
    >;
    expect(updatedProviderKeys[presets[1]!.provider]).toBe("sk-proxy-new");
  });

  it("migrates legacy inline apiKey to the secrets channel on first read", async () => {
    // Simulate legacy persisted blob containing an inline apiKey — this is
    // exactly what shipped in `settings.json` before the fix. We reset the
    // module registry so a fresh SettingsStore singleton re-hydrates from
    // this blob on initSettings().
    vi.resetModules();
    const legacyBlob = {
      schemaVersion: 1,
      savedAt: "2026-04-24T14:30:38.775Z",
      entries: {
        "llm.customPresets": [
          {
            id: "custom_legacy",
            name: "Legacy",
            provider: "dashscope",
            baseUrl: "https://dashscope.aliyuncs.com",
            model: "qwen3.6-flash",
            protocol: "openai-chat-v1",
            apiKey: "sk-legacy-leak",
          },
        ],
      },
    };
    localStorageMock.setItem(
      LOCAL_STORAGE_SETTINGS_KEY,
      JSON.stringify(legacyBlob),
    );

    const { initSettings: init2 } = await import("@/settings/store");
    const freshApi = await import("../api.js");
    await init2();

    const presets = freshApi.getCustomPresets();
    expect(presets[0]?.apiKey).toBe("sk-legacy-leak");
    await new Promise((r) => setTimeout(r, 0));

    const postSettings = readSettingsBlob() as {
      entries?: { "llm.customPresets"?: Array<Record<string, unknown>> };
    };
    const persistedAfter = postSettings.entries?.["llm.customPresets"] ?? [];
    expect(persistedAfter[0]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(postSettings)).not.toContain("sk-legacy-leak");

    const keys = readKeysBlob();
    expect(keys["preset:custom_legacy"]).toBe("sk-legacy-leak");
  });
});
