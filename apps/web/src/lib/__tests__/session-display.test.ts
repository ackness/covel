import { describe, expect, it } from "vitest";
import i18n from "@/i18n/index.js";
import { sessionStatusLabel, sessionTurnLabel } from "../session-display.js";

describe("session display labels", () => {
  it("localizes status and turn labels", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(sessionStatusLabel(i18n.t, "active")).toBe("进行中");
    expect(sessionTurnLabel(i18n.t, 3)).toBe("第 3 回合");

    await i18n.changeLanguage("en-US");
    expect(sessionStatusLabel(i18n.t, "paused")).toBe("Paused");
    expect(sessionTurnLabel(i18n.t, 1)).toBe("Turn 1");
  });
});
