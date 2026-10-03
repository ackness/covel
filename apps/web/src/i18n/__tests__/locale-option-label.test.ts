// @vitest-environment node
import { expect, it } from "vitest";
import { localeOptionLabel } from "../locale-option-label.js";

const label = { "en-US": "English", "zh-CN": "英语" };

it("marks a language that has no instruction set of its own", () => {
  expect(
    localeOptionLabel(
      { code: "ru-RU", label: { "en-US": "Russian" }, shortLabel: "RU" },
      "en-US",
      "experimental",
    ),
  ).toBe("Russian (experimental)");
});

it("leaves English and Simplified Chinese unmarked", () => {
  expect(
    localeOptionLabel(
      { code: "en-US", label, shortLabel: "EN" },
      "zh-CN",
      "实验性",
    ),
  ).toBe("英语");
  expect(
    localeOptionLabel(
      { code: "zh-CN", label: "简体中文", shortLabel: "ZH" },
      "en-US",
      "experimental",
    ),
  ).toBe("简体中文");
});
