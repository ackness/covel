import { expect, it } from "vitest";
import { resolveI18nDeep } from "../src/index.js";

it("localizes arbitrary JSON data without interpreting own prototype-named keys", () => {
  const data = JSON.parse(
    '{"__proto__":{"label":{"en":"Keeper","zh-CN":"守护者"}},"constructor":{"en":"Guild","zh-CN":"公会"}}',
  );
  const result = resolveI18nDeep(data, "en") as Record<string, unknown>;
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(result).toEqual(
    JSON.parse('{"__proto__":{"label":"Keeper"},"constructor":"Guild"}'),
  );
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(data.__proto__.label).toEqual({ en: "Keeper", "zh-CN": "守护者" });
});
