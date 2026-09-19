/**
 * Regression test: custom preset API keys must live in the secrets
 * channel (`covel:keys`), not inline inside `llm.providers` or the
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
  it("carries per-model reasoning defaults separately from role overrides", async () => {
    setProviderProfiles([
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://provider.example",
        models: [
          { ref: "a", modelId: "qwen3.8-flash", reasoningEffort: "disabled" },
          { ref: "b", modelId: "deepseek-v4-flash", reasoningEffort: "high" },
        ],
      },
    ]);
    setSlotConfig({ story: { modelRef: "a" }, memory: { modelRef: "b" } });
    setParamOverrides({ story: { reasoningEffort: "provider-default" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const header = JSON.parse(
      atob(buildSlotConfigHeaderInternal()["X-Slot-Config"]!),
    );
    expect(header.customPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", reasoningEffort: "disabled" }),
        expect.objectContaining({ id: "b", reasoningEffort: "high" }),
      ]),
    );
    expect(header.parameterOverrides.story).toEqual({
      reasoningEffort: "provider-default",
    });
    expect(readSettingsBlob()).toMatchObject({
      entries: {
        "llm.providers": [
          expect.objectContaining({
            models: [
              expect.objectContaining({ reasoningEffort: "disabled" }),
              expect.objectContaining({ reasoningEffort: "high" }),
            ],
          }),
        ],
      },
    });
  });
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

  it("keeps connection secrets separate from model profiles through reload", async () => {
    setProviderProfiles([
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.example/v1",
        models: [{ ref: "model-a", modelId: "opaque/model" }],
      },
    ]);
    await getSettings().set("keys.fixture", "synthetic-secret");
    expect(readKeysBlob().fixture).toBe("synthetic-secret");
    expect(JSON.stringify(readSettingsBlob())).not.toContain(
      "synthetic-secret",
    );
    expect(JSON.stringify(getCustomPresets())).not.toContain(
      "synthetic-secret",
    );

    vi.resetModules();
    const freshStore = await import("@/settings/store");
    await freshStore.initSettings();
    const freshApi = await import("../api/model-settings.js");
    expect(freshApi.getCustomPresets()[0]).toMatchObject({
      provider: "fixture",
      model: "opaque/model",
    });
    expect(
      freshStore
        .getSettings()
        .listEntries()
        .some((entry) => entry.key === "keys.fixture"),
    ).toBe(true);
    expect(
      JSON.parse(atob(freshApi.buildProviderKeysHeader()["X-Provider-Keys"]!)),
    ).toEqual({ fixture: "synthetic-secret" });
  });

  it("keeps a shared connection key until its last model is removed", async () => {
    const profile = {
      id: "fixture",
      name: "Fixture",
      baseUrl: "",
      models: [
        { ref: "a", modelId: "a" },
        { ref: "b", modelId: "b" },
      ],
    };
    setProviderProfiles([profile]);
    await getSettings().set("keys.fixture", "synthetic-secret");
    setProviderProfiles([{ ...profile, models: [profile.models[0]!] }]);
    await vi.waitFor(() => expect(getCustomPresets()).toHaveLength(1));
    expect(readKeysBlob().fixture).toBe("synthetic-secret");
    setProviderProfiles([]);
    await vi.waitFor(() => expect(readKeysBlob().fixture).toBeUndefined());
  });

  it("uses each connection's own key without borrowing from its provider family", async () => {
    setProviderProfiles(
      ["official", "proxy"].map((id) => ({
        id,
        provider: "openai",
        name: id,
        baseUrl: `https://${id}.example/v1`,
        models: [{ ref: `${id}-model`, modelId: "same-model" }],
      })),
    );
    await getSettings().set("keys.openai", "synthetic-family");
    await getSettings().set("keys.official", "synthetic-official");
    expect(
      JSON.parse(atob(buildProviderKeysHeader()["X-Provider-Keys"]!)),
    ).toEqual({
      openai: "synthetic-family",
      official: "synthetic-official",
    });
    await getSettings().set("keys.proxy", "synthetic-proxy");
    expect(
      JSON.parse(atob(buildProviderKeysHeader()["X-Provider-Keys"]!)),
    ).toEqual({
      openai: "synthetic-family",
      official: "synthetic-official",
      proxy: "synthetic-proxy",
    });
    expect(getCustomPresets().map((preset) => preset.provider)).toEqual([
      "official",
      "proxy",
    ]);
  });
});

describe("current-only model settings", () => {
  it("does not revive profiles from obsolete model settings", async () => {
    await getSettings().set("llm.customPresets", [
      {
        id: "obsolete",
        name: "Obsolete",
        provider: "fixture",
        model: "old",
      },
    ]);
    await getSettings().set("llm.providers", []);
    expect(getCustomPresets()).toEqual([]);
  });

  it("does not rewrite a saved server binding while reading settings", async () => {
    setProviderProfiles([
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "",
        models: [{ ref: "shared-id", modelId: "current" }],
      },
    ]);
    await getSettings().set("llm.slotConfig", {
      story: { presetId: "shared-id" },
    });
    const { getSlotConfig } = await import("../api.js");
    const before = readSettingsBlob();
    expect(getSlotConfig()).toEqual({ story: { presetId: "shared-id" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readSettingsBlob()).toEqual(before);
  });

  it("never sends a server-managed marker for a configured connection", async () => {
    setProviderProfiles([
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "",
        models: [{ ref: "current", modelId: "current" }],
      },
    ]);
    await getSettings().set("keys.fixture", SERVER_MANAGED_SECRET);
    expect(buildProviderKeysHeader()).toEqual({});
  });
});
