import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../runtimes/check/handler.js";

afterEach(() => vi.unstubAllEnvs());

function context(locale) {
  return {
    locale,
    turnId: "turn-1",
    pluginId: "tabletop-rules",
    inputs: {
      rules: { value: { attributes: [{ id: "combat", base: 1, max: 5 }] } },
    },
    tools: {
      call: async () => ({ characters: [{ id: "player", fields: {} }] }),
    },
    pluginData: { get: async () => null, set: async () => {} },
    store: { listPlayerInputs: async () => [] },
  };
}

describe("check instructions", () => {
  it("follow the instruction language, not the session language", async () => {
    expect((await handler(context("zh-CN"))).value.checkContext).toBe(
      "No tabletop check submitted（本回合没有提交跑团检定，不要编造掷骰）",
    );
    expect((await handler(context("ru-RU"))).value.checkContext).toBe(
      "No tabletop check submitted. Do not invent a roll.",
    );
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    expect((await handler(context("zh-CN"))).value.checkContext).toBe(
      "No tabletop check submitted. Do not invent a roll.",
    );
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
    expect((await handler(context("en-US"))).value.checkContext).toBe(
      "No tabletop check submitted（本回合没有提交跑团检定，不要编造掷骰）",
    );
  });
});
