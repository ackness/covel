import type { PluginUserSettingSpec } from "./types/plugin.js";

export function isValidPluginSetting(
  value: unknown,
  spec: PluginUserSettingSpec,
): boolean {
  switch (spec.type) {
    case "number":
    case "integer":
    case "slider":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (spec.type === "integer" && !Number.isInteger(value)) return false;
      if (typeof spec.min === "number" && value < spec.min) return false;
      if (typeof spec.max === "number" && value > spec.max) return false;
      return true;
    case "toggle":
      return typeof value === "boolean";
    case "select":
      return (
        typeof value === "string" &&
        (!spec.options ||
          spec.options.length === 0 ||
          spec.options.some((o) => o.value === value))
      );
    case "text":
    case "textarea":
      return typeof value === "string";
    default:
      return true;
  }
}
