import { describe, expect, it } from "vitest";
import {
  SettingsStore,
  type SettingKey,
  type SettingsBackendAdapter,
} from "@covel/settings";
import { registerLlmSettings } from "../registry/llm.js";

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
