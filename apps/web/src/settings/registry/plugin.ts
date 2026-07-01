import { z } from "zod";
import type { PluginUserSettingSpec } from "@covel/shared";
import type { SettingsStoreApi, WidgetKind } from "@covel/settings";

// `PluginUserSettingSpec` is the single source of truth in `@covel/shared`
// (parsed from PLUGIN.md frontmatter). This module only maps it onto the
// SettingsStore registry — it does not redefine the shape.

export function registerPluginUserSettings(
  store: SettingsStoreApi,
  pluginId: string,
  specs: readonly PluginUserSettingSpec[] | undefined,
): void {
  if (!specs) return;
  for (const spec of specs) {
    store.register({
      key: `plugin.${pluginId}.${spec.key}`,
      schema: schemaFor(spec),
      default: spec.default,
      group: "plugin",
      pluginId,
      widget: widgetFor(spec.type),
      label: spec.label,
      description: spec.description,
      options: spec.options,
      min: spec.min,
      max: spec.max,
      step: spec.step,
    });
  }
}

function widgetFor(type: PluginUserSettingSpec["type"]): WidgetKind {
  switch (type) {
    case "text":
      return "text";
    case "textarea":
      return "textarea";
    case "number":
    case "integer":
      return "number";
    case "slider":
      return "slider";
    case "toggle":
      return "toggle";
    case "select":
      return "select";
  }
}

// Build a Zod schema that ENFORCES the declared constraints (min/max/options),
// not just renders a widget hint. An out-of-range value is rejected at `set()`.
function schemaFor(spec: PluginUserSettingSpec): z.ZodType {
  switch (spec.type) {
    case "text":
    case "textarea":
      return z.string();
    case "number":
    case "integer":
    case "slider": {
      let n = spec.type === "integer" ? z.number().int() : z.number();
      if (typeof spec.min === "number") n = n.min(spec.min);
      if (typeof spec.max === "number") n = n.max(spec.max);
      return n;
    }
    case "toggle":
      return z.boolean();
    case "select": {
      const values = (spec.options ?? []).map((o) => o.value);
      if (values.length === 0) return z.string();
      return z.enum(values as [string, ...string[]]);
    }
  }
}
