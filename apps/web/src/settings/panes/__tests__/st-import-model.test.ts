// @vitest-environment node
import { expect, it } from "vitest";
import type { StImportItem } from "@covel/shared";
import { groupImportItems, importItemText } from "../st-import-model.js";
const item: StImportItem = {
  level: "warning",
  code: "future-code",
  message: "Server explanation",
  count: 3,
};
it("groups in severity order and omits empty groups", () => {
  expect(
    groupImportItems([
      item,
      { ...item, level: "info" },
      { ...item, level: "error" },
    ]).map((group) => group.level),
  ).toEqual(["error", "warning", "info"]);
  expect(groupImportItems([])).toEqual([]);
});
it("shows count and falls back for unknown codes", () =>
  expect(
    importItemText(
      item,
      () => "unused",
      () => false,
    ),
  ).toBe("Server explanation (3)"));
it("localizes known codes and retains the field", () =>
  expect(
    importItemText(
      { ...item, field: "keys" },
      () => "Translated",
      () => true,
    ),
  ).toBe("Translated · keys (3)"));
it("keeps omitted extension names visible with localized labels", () => {
  expect(
    importItemText(
      {
        ...item,
        code: "extensions-ignored",
        message: "Extensions were omitted: regex_scripts, world",
      },
      () => "Translated",
      () => true,
    ),
  ).toBe("Translated regex_scripts, world (3)");
});
