import { describe, expect, it } from "vitest";
import {
  buildCurrentTurnUserMessage,
  renderCoreMemory,
  resolveLocaleLanguageName,
} from "../src/prompt-internals.js";

describe("prompt locale normalization", () => {
  it("uses the shared language subtag for prompt variants", () => {
    expect(
      buildCurrentTurnUserMessage({
        playerMessage: "",
        locale: "ZH_cn",
      }),
    ).toContain("开始当前游戏回合");
    expect(resolveLocaleLanguageName("en_GB")).toBe("English");
    expect(
      renderCoreMemory([{ label: "story", content: "Remember this" }], "EN_us"),
    ).toContain("[Core Memory]");
  });
});
