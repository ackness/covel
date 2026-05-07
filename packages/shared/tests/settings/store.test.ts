import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SettingsStore } from "../../src/settings/store.js";
import { createMemoryAdapter } from "./test-adapter.js";

function makeStore(
  initial: Record<string, unknown> = {},
  secrets: Record<string, string> = {},
) {
  const adapter = createMemoryAdapter(initial, secrets);
  const store = new SettingsStore(adapter);
  return { store, adapter };
}

describe("SettingsStore", () => {
  it("returns the registered default when no value is stored", async () => {
    const { store } = makeStore();
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    await store.init();
    expect(store.get("ui.locale")).toBe("zh-CN");
  });

  it("persists set() through the adapter", async () => {
    const { store, adapter } = makeStore();
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    await store.init();
    await store.set("ui.locale", "en-US");
    expect(store.get("ui.locale")).toBe("en-US");
    expect(adapter.readEntries()).toEqual({ "ui.locale": "en-US" });
  });

  it("rejects values that fail schema validation", async () => {
    const { store } = makeStore();
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    await store.init();
    await expect(
      store.set("ui.locale", "fr-FR" as unknown as "zh-CN"),
    ).rejects.toThrow(/validation/);
  });

  it("notifies subscribers on change", async () => {
    const { store } = makeStore();
    store.register({
      key: "ui.appearance",
      schema: z.enum(["modern", "paper"]),
      default: "modern",
      group: "general",
      label: "Appearance",
    });
    await store.init();
    const seen: string[] = [];
    const unsubscribe = store.subscribe<string>("ui.appearance", (v) =>
      seen.push(v),
    );
    await store.set("ui.appearance", "paper");
    unsubscribe();
    await store.set("ui.appearance", "modern");
    expect(seen).toEqual(["paper"]);
  });

  it("clears a single key back to its default", async () => {
    const { store } = makeStore({ "ui.appearance": "paper" });
    store.register({
      key: "ui.appearance",
      schema: z.enum(["modern", "paper"]),
      default: "modern",
      group: "general",
      label: "Appearance",
    });
    await store.init();
    expect(store.get("ui.appearance")).toBe("paper");
    await store.clear("ui.appearance");
    expect(store.get("ui.appearance")).toBe("modern");
  });

  it('routes backend="keys" to the secrets channel', async () => {
    const { store, adapter } = makeStore({}, { openai: "sk-legacy" });
    store.register({
      key: "keys.openai",
      schema: z.string(),
      default: "",
      group: "llm",
      label: "OpenAI",
      backend: "keys",
      widget: "secret",
    });
    await store.init();
    expect(store.get("keys.openai")).toBe("sk-legacy");
    await store.set("keys.openai", "sk-new");
    expect(adapter.readSecrets()).toEqual({ openai: "sk-new" });
    expect(adapter.readEntries()).toEqual({});
  });

  it("empty string on a secret entry deletes the provider key", async () => {
    const { store, adapter } = makeStore({}, { openai: "sk-legacy" });
    store.register({
      key: "keys.openai",
      schema: z.string(),
      default: "",
      group: "llm",
      label: "OpenAI",
      backend: "keys",
      widget: "secret",
    });
    await store.init();
    await store.set("keys.openai", "   ");
    expect(store.has("keys.openai")).toBe(false);
    expect(adapter.readSecrets()).toEqual({});
  });

  it("export excludes secrets by default and includes them when requested", async () => {
    const { store } = makeStore({ "ui.locale": "en-US" }, { openai: "sk-x" });
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    store.register({
      key: "keys.openai",
      schema: z.string(),
      default: "",
      group: "llm",
      label: "OpenAI",
      backend: "keys",
    });
    await store.init();
    const bare = await store.export();
    expect(bare.keys).toBeUndefined();
    expect(bare.entries).toEqual({ "ui.locale": "en-US" });
    const withSecrets = await store.export({ includeSecrets: true });
    expect(withSecrets.keys).toEqual({ openai: "sk-x" });
  });

  it("selective import only applies chosen keys", async () => {
    const { store } = makeStore();
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    store.register({
      key: "ui.appearance",
      schema: z.enum(["modern", "paper"]),
      default: "modern",
      group: "general",
      label: "Appearance",
    });
    await store.init();
    const bundle = {
      schemaVersion: 1 as const,
      exportedAt: "now",
      entries: { "ui.locale": "en-US", "ui.appearance": "paper" },
    };
    await store.import(bundle, { keys: ["ui.locale"] });
    expect(store.get("ui.locale")).toBe("en-US");
    expect(store.get("ui.appearance")).toBe("modern");
  });

  it("clearGroup clears every entry in the group but leaves others", async () => {
    const { store } = makeStore({
      "ui.locale": "en-US",
      "llm.slotConfig": { default: {} },
    });
    store.register({
      key: "ui.locale",
      schema: z.enum(["zh-CN", "en-US"]),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    store.register({
      key: "llm.slotConfig",
      schema: z.record(z.string(), z.unknown()),
      default: {},
      group: "llm",
      label: "Slots",
    });
    await store.init();
    await store.clearGroup("general");
    expect(store.get("ui.locale")).toBe("zh-CN");
    expect(store.get<{ default?: unknown }>("llm.slotConfig")).toEqual({
      default: {},
    });
  });

  it("list() filters registry by group", async () => {
    const { store } = makeStore();
    store.register({
      key: "ui.locale",
      schema: z.string(),
      default: "zh-CN",
      group: "general",
      label: "Locale",
    });
    store.register({
      key: "llm.slotConfig",
      schema: z.record(z.string(), z.unknown()),
      default: {},
      group: "llm",
      label: "Slots",
    });
    await store.init();
    expect(store.list("general").map((e) => e.key)).toEqual(["ui.locale"]);
    expect(store.list("llm").map((e) => e.key)).toEqual(["llm.slotConfig"]);
  });
});
