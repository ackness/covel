import { describe, expect, it, vi } from "vitest";
import {
  SettingsStore,
  type SettingKey,
  type SettingsBackendAdapter,
} from "@covel/settings";
import {
  providerModelProfilesSchema,
  registerLlmSettings,
} from "../registry/llm.js";
import {
  slotBindingId,
  type SlotConfigEntry,
} from "@/services/api/model-settings.js";

function createMemoryAdapter(): SettingsBackendAdapter {
  let entries: Record<SettingKey, unknown> = {};
  let secrets: Record<string, string> = {};

  return {
    async load() {
      return { ...entries };
    },
    async save(next) {
      entries = { ...next };
    },
    async loadSecrets() {
      return { ...secrets };
    },
    async saveSecrets(next) {
      secrets = { ...next };
    },
  };
}

describe("LLM settings registry validation", () => {
  it.each(["connection case", "connection key name", "model reference"])(
    "rejects a normalized %s collision before importing any selected values or secrets",
    async (collision) => {
      const adapter = createMemoryAdapter();
      const store = new SettingsStore(adapter);
      registerLlmSettings(store);
      await store.init();
      const profile = {
        id: "saved",
        name: "Saved",
        baseUrl: "https://saved.example/v1",
        models: [{ ref: "saved-ref", modelId: "Vendor/Original:Variant" }],
      };
      const before = {
        "llm.providers": [profile],
        "llm.slotConfig": { story: { modelRef: "saved-ref" } },
      };
      await store.setMany(before);
      await store.set("keys.saved", "synthetic-secret");
      const save = vi.spyOn(adapter, "save");
      const saveSecrets = vi.spyOn(adapter, "saveSecrets");
      const conflicting = [
        {
          ...profile,
          id: "my-provider",
          models: [{ ref: "same", modelId: "first" }],
        },
        {
          ...profile,
          id:
            collision === "connection case"
              ? "MY-PROVIDER"
              : collision === "connection key name"
                ? "MY_PROVIDER_API_KEY"
                : "different-connection",
          models: [
            {
              ref: collision === "model reference" ? " same " : "different",
              modelId: "second",
            },
          ],
        },
      ];
      await expect(
        store.import(
          {
            schemaVersion: 1,
            exportedAt: "2026-09-19T00:00:00.000Z",
            entries: {
              "llm.slotConfig": { story: { modelRef: "same" } },
              "llm.providers": conflicting,
            },
            keys: { saved: "replacement-secret" },
          },
          {
            keys: ["llm.providers", "llm.slotConfig"],
            includeSecrets: true,
          },
        ),
      ).rejects.toThrow("Settings validation failed for llm.providers");
      await expect(store.set("llm.providers", conflicting)).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
      expect(saveSecrets).not.toHaveBeenCalled();
      expect(await adapter.load()).toEqual(before);
      expect(store.get("llm.providers")).toEqual(before["llm.providers"]);
      expect(store.get("llm.slotConfig")).toEqual(before["llm.slotConfig"]);
      expect(await adapter.loadSecrets()).toEqual({
        saved: "synthetic-secret",
      });
    },
  );

  it("normalizes connection identities and references idempotently while preserving model IDs and bindings", async () => {
    const raw = [
      {
        id: " My_Connection ",
        provider: "openai",
        name: "My connection",
        baseUrl: "https://custom.example/v1",
        models: [{ ref: "  Original.Ref-1  ", modelId: "Vendor/Case:Version" }],
      },
    ];
    const expected = [
      {
        ...raw[0],
        id: "my-connection",
        models: [{ ref: "Original.Ref-1", modelId: "Vendor/Case:Version" }],
      },
    ];
    const normalized = providerModelProfilesSchema.parse(raw);
    expect(normalized).toEqual(expected);
    expect(providerModelProfilesSchema.parse(normalized)).toEqual(normalized);
    expect(() =>
      providerModelProfilesSchema.parse([
        {
          ...raw[0],
          models: [{ ref: "  ", modelId: "Vendor/Case:Version" }],
        },
      ]),
    ).toThrow();

    const adapter = createMemoryAdapter();
    const store = new SettingsStore(adapter);
    registerLlmSettings(store);
    await store.init();
    await store.import(
      {
        schemaVersion: 1,
        exportedAt: "2026-09-19T00:00:00.000Z",
        entries: {
          "llm.providers": raw,
          "llm.slotConfig": { story: { modelRef: "  Original.Ref-1  " } },
        },
      },
      { keys: ["llm.providers", "llm.slotConfig"] },
    );
    expect(await adapter.load()).toEqual({
      "llm.providers": expected,
      "llm.slotConfig": { story: { modelRef: "Original.Ref-1" } },
    });
  });

  it("preserves current local and server bindings through hydration, import, writes and reload", async () => {
    const adapter = createMemoryAdapter();
    const entries = {
      "llm.slotConfig": {
        story: { modelRef: "chosen-model" },
      },
    };
    await adapter.save(entries);
    const store = new SettingsStore(adapter);
    registerLlmSettings(store);
    await store.init();
    const binding = () =>
      store.get<Record<string, SlotConfigEntry>>("llm.slotConfig").story;
    expect(slotBindingId(binding())).toBe("chosen-model");
    await store.set("llm.slotConfig", entries["llm.slotConfig"]);
    expect(slotBindingId(binding())).toBe("chosen-model");
    await store.import(
      { schemaVersion: 1, exportedAt: "", entries },
      { keys: ["llm.slotConfig"] },
    );
    expect(slotBindingId(binding())).toBe("chosen-model");
    const reloaded = new SettingsStore(adapter);
    registerLlmSettings(reloaded);
    await reloaded.init();
    expect(reloaded.get("llm.slotConfig")).toEqual({
      story: { modelRef: "chosen-model" },
    });
    await reloaded.set("llm.slotConfig", {
      story: { presetId: "server-model" },
    });
    expect(reloaded.get("llm.slotConfig")).toEqual({
      story: { presetId: "server-model" },
    });
  });

  it("rejects ambiguous bindings instead of selecting a field by precedence", async () => {
    const store = new SettingsStore(createMemoryAdapter());
    registerLlmSettings(store);
    await store.init();
    await store.set("llm.slotConfig", { story: { modelRef: "current" } });
    await expect(
      store.set("llm.slotConfig", {
        story: { modelRef: "current", presetId: "server" },
      }),
    ).rejects.toThrow();
    expect(store.get("llm.slotConfig")).toEqual({
      story: { modelRef: "current" },
    });
  });

  it("rejects imported provider profiles with a non-string provider", async () => {
    const store = new SettingsStore(createMemoryAdapter());
    registerLlmSettings(store);
    await store.init();

    const existing = [
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        models: [{ ref: "deepseek-chat", modelId: "deepseek-chat" }],
      },
    ];
    await store.set("llm.providers", existing);

    await expect(
      store.import(
        {
          schemaVersion: 1,
          exportedAt: "2026-08-24T00:00:00.000Z",
          entries: {
            "llm.providers": [
              {
                id: "broken",
                name: "Broken",
                provider: 42,
                baseUrl: "https://example.com",
                models: [{ ref: "broken-model", modelId: "broken-model" }],
              },
            ],
          },
        },
        { keys: ["llm.providers"] },
      ),
    ).rejects.toThrow("Settings validation failed for llm.providers");

    expect(store.get("llm.providers")).toEqual(existing);
  });
});
