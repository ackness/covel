// @vitest-environment node
import { expect, it } from "vitest";
import { localeOptionLabel } from "../locale-option-label.js";

const label = { "en-US": "English", "zh-CN": "英语" };

it("marks a language that has no instruction set of its own", () => {
  expect(
    localeOptionLabel(
      {
        code: "ru-RU",
        label: { "en-US": "Russian", "ru-RU": "Русский" },
        shortLabel: "RU",
      },
      "experimental",
    ),
  ).toBe("Русский (experimental)");
});

it("names each language in that language and leaves English and Simplified Chinese unmarked", () => {
  expect(
    localeOptionLabel({ code: "en-US", label, shortLabel: "EN" }, "实验性"),
  ).toBe("English");
  expect(
    localeOptionLabel(
      { code: "zh-CN", label: "简体中文", shortLabel: "ZH" },
      "experimental",
    ),
  ).toBe("简体中文");
});
