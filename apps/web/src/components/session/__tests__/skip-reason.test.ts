// @vitest-environment node
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { skipReasonText } from "../execution-runtime-status.js";

describe("skipReasonText", () => {
  it("translates the framework's skip codes", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(skipReasonText("upstream-failed", i18n.t)).toBe(
      "它依赖的任务没有成功",
    );
    expect(skipReasonText("input-schema-invalid", i18n.t)).toBe(
      "它收到的输入不能用",
    );
    await i18n.changeLanguage("en-US");
    expect(skipReasonText("setup-incomplete", i18n.t)).toBe(
      "Setup is not finished",
    );
  });

  it("leaves other text as it is", () => {
    expect(skipReasonText("cooldown", i18n.t)).toBe("cooldown");
    expect(skipReasonText(undefined, i18n.t)).toBeUndefined();
  });
});
