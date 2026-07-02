import { describe, it, expect, vi } from "vitest";
import { parsePluginLlmToml } from "../src/plugin-llm-config.js";

describe("parsePluginLlmToml", () => {
  it("maps [plugin.<slot>] sections into slots", () => {
    const config = parsePluginLlmToml(
      [
        "[plugin.default]",
        'provider = "dashscope"',
        'model = "qwen3.5-flash"',
        'baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"',
        'protocol = "openai-chat-v1"',
        "",
        "[plugin.fast]",
        'provider = "openai"',
        'model = "gpt-4o-mini"',
      ].join("\n"),
    );

    expect(config.defaultSlot).toEqual({
      provider: "dashscope",
      model: "qwen3.5-flash",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      protocol: "openai-chat-v1",
    });
    expect(config.slots.fast).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: undefined,
      protocol: undefined,
    });
  });

  it("skips a slot missing provider or model", () => {
    const config = parsePluginLlmToml(
      ["[plugin.broken]", 'model = "only-model"'].join("\n"),
    );
    expect(config.slots).toEqual({});
    expect(config.defaultSlot).toBeUndefined();
  });

  it("returns empty config on malformed TOML without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = parsePluginLlmToml("[plugin.default\nprovider =");
    expect(config).toEqual({ slots: {} });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
