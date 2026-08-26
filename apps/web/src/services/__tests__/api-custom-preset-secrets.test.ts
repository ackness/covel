/**
 * Regression test: custom preset API keys must live in the secrets
 * channel (`covel:keys`), NOT inline inside `llm.customPresets` / the
 * `covel:settings` blob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_STORAGE_KEYS_KEY,
  LOCAL_STORAGE_SETTINGS_KEY,
  SERVER_MANAGED_SECRET,
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

type SettingsModule = typeof import("@/settings/store");
type ApiModule = typeof import("../api.js");
type ModelSettingsModule = typeof import("../api/model-settings.js");

let getSettings: SettingsModule["getSettings"];
let initSettings: SettingsModule["initSettings"];
let getCustomPresets: ApiModule["getCustomPresets"];
let getProviderPriceMultiplier: ApiModule["getProviderPriceMultiplier"];
let removeCustomPreset: ApiModule["removeCustomPreset"];
let setCustomPresets: ApiModule["setCustomPresets"];
let setParamOverrides: ApiModule["setParamOverrides"];
let setProviderProfiles: ApiModule["setProviderProfiles"];
let setProviderPriceMultipliers: ApiModule["setProviderPriceMultipliers"];
let setSlotConfig: ApiModule["setSlotConfig"];
let buildProviderKeysHeader: ModelSettingsModule["buildProviderKeysHeader"];
let buildSlotConfigHeaderInternal: ModelSettingsModule["buildSlotConfigHeaderInternal"];

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
  // Settings v2 intentionally detects stale full-snapshot writers. Give each
  // test a fresh singleton so clearing the mocked storage cannot leave an old
  // in-memory revision alive across test cases.
  vi.resetModules();
  localStorageMock.clear();
  ({ getSettings, initSettings } = await import("@/settings/store"));
  ({
    getCustomPresets,
    getProviderPriceMultiplier,
    removeCustomPreset,
    setCustomPresets,
    setParamOverrides,
    setProviderProfiles,
    setProviderPriceMultipliers,
    setSlotConfig,
  } = await import("../api.js"));
  ({ buildProviderKeysHeader, buildSlotConfigHeaderInternal } =
    await import("../api/model-settings.js"));
  await initSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom preset secret channel", () => {
  it("never sends the REST server-managed marker as an API key", async () => {
    await getSettings().set("keys.server-only", SERVER_MANAGED_SECRET);

    const encoded = buildProviderKeysHeader()["X-Provider-Keys"];
    const keys = encoded
      ? (JSON.parse(atob(encoded)) as Record<string, string>)
      : {};
    expect(keys["server-only"]).toBeUndefined();
    expect(Object.values(keys)).not.toContain(SERVER_MANAGED_SECRET);
  });

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

  it("sends only operational capability overrides in X-Slot-Config", async () => {
    await getSettings().set("llm.capabilityOverrides", {
      story: {
        input: ["text", "image"],
        output: ["text"],
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        pricing: { inputPerMToken: 0.01, outputPerMToken: 0.02 },
      },
    });

    const encoded = buildSlotConfigHeaderInternal()["X-Slot-Config"];
    const overlay = JSON.parse(atob(encoded!));
    expect(overlay.capabilityOverrides).toEqual({
      story: {
        input: ["text", "image"],
        output: ["text"],
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
      },
    });
    expect(JSON.stringify(overlay)).not.toContain("pricing");
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
      entries?: {
        "llm.customPresets"?: Array<Record<string, unknown>>;
        "llm.providers"?: Array<Record<string, unknown>>;
      };
    };
    const persisted = settings.entries?.["llm.customPresets"] ?? [];
    expect(persisted).toHaveLength(0);
    expect(settings.entries?.["llm.providers"]).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain("sk-topsecret");

    const keys = readKeysBlob();
    expect(keys["preset:custom_x1"]).toBeUndefined();
    expect(keys.dashscope).toBe("sk-topsecret");
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
    expect(keys.dashscope).toBeUndefined();
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
    // API keys are connection-scoped in the canonical provider model. Both
    // OpenAI models shared one connection, so the legacy last-model key stays
    // authoritative even after one model is removed.
    expect(keys.openai).toBe("sk-remove-model");
    expect(keys.anthropic).toBeUndefined();
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

  it("keeps legacy getters read-only until the explicit migration runs", async () => {
    vi.resetModules();
    const legacyBlob = {
      schemaVersion: 1,
      savedAt: "old",
      entries: {
        "llm.customPresets": [
          {
            id: "legacy_read_only",
            name: "Legacy",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-5",
            apiKey: "sk-read-only",
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
    const beforeSettings = localStorageMock.getItem(LOCAL_STORAGE_SETTINGS_KEY);
    const beforeKeys = localStorageMock.getItem(LOCAL_STORAGE_KEYS_KEY);

    expect(freshApi.getProviderProfiles()).toHaveLength(1);
    expect(freshApi.getCustomPresets()[0]?.apiKey).toBe("sk-read-only");

    expect(localStorageMock.getItem(LOCAL_STORAGE_SETTINGS_KEY)).toBe(
      beforeSettings,
    );
    expect(localStorageMock.getItem(LOCAL_STORAGE_KEYS_KEY)).toBe(beforeKeys);
  });

  it("preserves legacy data on migration failure and retries successfully", async () => {
    vi.resetModules();
    localStorageMock.setItem(
      LOCAL_STORAGE_SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: "old",
        entries: {
          "llm.customPresets": [
            {
              id: "legacy_retry",
              name: "Retry",
              provider: "dashscope",
              baseUrl: "https://dashscope.aliyuncs.com",
              model: "qwen3.6-flash",
              apiKey: "sk-retry",
            },
          ],
        },
      }),
    );
    const { initSettings: init2 } = await import("@/settings/store");
    const freshApi = await import("../api.js");
    await init2();
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });

    await freshApi.migrateLegacyProviderProfiles();
    expect(
      (readSettingsBlob() as { entries?: Record<string, unknown> }).entries?.[
        "llm.customPresets"
      ],
    ).toBeDefined();

    await freshApi.migrateLegacyProviderProfiles();
    const entries = (
      readSettingsBlob() as {
        entries?: Record<string, unknown>;
      }
    ).entries;
    expect(entries?.["llm.providers"]).toBeDefined();
    expect(entries?.["llm.customPresets"]).toBeUndefined();
    expect(readKeysBlob().dashscope).toBe("sk-retry");
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

    await freshApi.migrateLegacyProviderProfiles();
    const presets = freshApi.getCustomPresets();
    expect(presets[0]?.apiKey).toBe("sk-legacy-leak");
    await new Promise((r) => setTimeout(r, 0));

    const postSettings = readSettingsBlob() as {
      entries?: { "llm.customPresets"?: Array<Record<string, unknown>> };
    };
    const persistedAfter = postSettings.entries?.["llm.customPresets"] ?? [];
    expect(persistedAfter).toHaveLength(0);
    expect(JSON.stringify(postSettings)).not.toContain("sk-legacy-leak");

    const keys = readKeysBlob();
    expect(keys["preset:custom_legacy"]).toBeUndefined();
    expect(keys.dashscope).toBe("sk-legacy-leak");
  });

  it("copies legacy preset keys into connection-specific profile namespaces", async () => {
    vi.resetModules();
    localStorageMock.setItem(
      LOCAL_STORAGE_SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: "2026-08-24T00:00:00.000Z",
        entries: {
          "llm.customPresets": [
            {
              id: "official_model",
              name: "Official",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5",
              protocol: "openai-responses-v1",
            },
            {
              id: "official_mini_model",
              name: "Official Mini",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5-mini",
              protocol: "openai-responses-v1",
            },
            {
              id: "proxy_model",
              name: "Proxy",
              provider: "openai",
              baseUrl: "https://proxy.example/v1",
              model: "gpt-4.1",
              protocol: "openai-chat-v1",
            },
          ],
        },
      }),
    );
    localStorageMock.setItem(
      LOCAL_STORAGE_KEYS_KEY,
      JSON.stringify({
        "preset:official_model": "sk-official",
        "preset:official_mini_model": "sk-official-latest",
        "preset:proxy_model": "sk-proxy",
      }),
    );

    const { initSettings: init2 } = await import("@/settings/store");
    const freshApi = await import("../api.js");
    await init2();
    await freshApi.migrateLegacyProviderProfiles();

    const profiles = freshApi.getProviderProfiles();
    const profileByModelRef = new Map(
      profiles.flatMap((profile) =>
        profile.models.map((model) => [model.ref, profile.id] as const),
      ),
    );
    expect(profileByModelRef.get("official_mini_model")).toBe(
      profileByModelRef.get("official_model"),
    );
    await vi.waitFor(() => {
      const keys = readKeysBlob();
      expect(keys[profileByModelRef.get("official_model")!]).toBe(
        "sk-official-latest",
      );
      expect(keys[profileByModelRef.get("proxy_model")!]).toBe("sk-proxy");
    });
  });

  it("backfills keys for profiles migrated by an earlier version", async () => {
    vi.resetModules();
    localStorageMock.setItem(
      LOCAL_STORAGE_SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: "2026-08-24T00:00:00.000Z",
        entries: {
          "llm.providers": [
            {
              id: "openai-official-model",
              provider: "openai",
              name: "Official",
              baseUrl: "https://api.openai.com/v1",
              protocol: "openai-responses-v1",
              models: [{ ref: "official_model", modelId: "gpt-5" }],
            },
            {
              id: "openai-proxy-model",
              provider: "openai",
              name: "Proxy Chat",
              baseUrl: "https://proxy.example/v1",
              protocol: "openai-chat-v1",
              models: [{ ref: "proxy_model", modelId: "gpt-4.1" }],
            },
            {
              id: "openai-proxy-responses-model",
              provider: "openai",
              name: "Proxy Responses",
              baseUrl: "https://proxy.example/v1",
              protocol: "openai-responses-v1",
              models: [{ ref: "proxy_responses_model", modelId: "gpt-5-mini" }],
            },
          ],
        },
      }),
    );
    localStorageMock.setItem(
      LOCAL_STORAGE_KEYS_KEY,
      JSON.stringify({
        openai: "sk-provider-fallback",
        "preset:official_model": "sk-official",
        "preset:proxy_model": "sk-stale-proxy",
        "openai-proxy-model": "sk-current-proxy",
      }),
    );

    const { initSettings: init2 } = await import("@/settings/store");
    const freshApi = await import("../api.js");
    await init2();

    await freshApi.migrateLegacyProviderProfiles();
    await vi.waitFor(() => {
      const keys = readKeysBlob();
      expect(keys["openai-official-model"]).toBe("sk-official");
      expect(keys["openai-proxy-model"]).toBe("sk-current-proxy");
      expect(keys["openai-proxy-responses-model"]).toBe("sk-provider-fallback");
      expect(keys["preset:official_model"]).toBeUndefined();
    });
  });
});
