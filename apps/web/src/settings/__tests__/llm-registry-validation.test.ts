import { describe, expect, it } from "vitest";
import {
  SettingsStore,
  type SettingKey,
  type SettingsBackendAdapter,
} from "@covel/settings";
import { registerLlmSettings } from "../registry/llm.js";
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
  it("preserves modelRef precedence through hydration, import, writes and reload", async () => {
    const adapter = createMemoryAdapter();
    const entries = {
      "llm.slotConfig": {
        story: { presetId: "legacy-model", modelRef: "chosen-model" },
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
      story: { presetId: "legacy-only" },
    });
    expect(reloaded.get("llm.slotConfig")).toEqual({
      story: { presetId: "legacy-only" },
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

    await store.import(
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
    );

    expect(store.get("llm.providers")).toEqual(existing);
  });
});
