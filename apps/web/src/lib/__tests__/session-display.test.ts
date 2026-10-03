// @vitest-environment node
import { describe, expect, it } from "vitest";
import i18n from "@/i18n/index.js";
import {
  sessionContinueLabel,
  sessionStatusLabel,
  sessionTurnLabel,
} from "../session-display.js";

describe("session display labels", () => {
  it("localizes status and turn labels", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(sessionStatusLabel(i18n.t, "active")).toBe("进行中");
    expect(sessionTurnLabel(i18n.t, 3)).toBe("第 3 回合");

    await i18n.changeLanguage("en-US");
    expect(sessionStatusLabel(i18n.t, "paused")).toBe("Paused");
    expect(sessionTurnLabel(i18n.t, 1)).toBe("Turn 1");
  });

  it("names the turn when resuming, except before the first one", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(sessionContinueLabel(i18n.t, 5)).toBe("继续 · 第 5 回合");
    expect(sessionContinueLabel(i18n.t, 0)).toBe("继续");
  });
});
