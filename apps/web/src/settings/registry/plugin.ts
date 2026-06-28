import { z } from "zod";
import type {
  SettingEntry,
  SettingsStoreApi,
  WidgetKind,
} from "@covel/settings";

/**
 * Specification for a user-editable setting declared by a plugin in its
 * `PLUGIN.md` frontmatter `userSettings` array. Shape is intentionally small
 * — we don't want plugin authors writing raw Zod.
 */
export interface PluginUserSettingSpec {
  key: string;
  type: "text" | "number" | "toggle" | "select" | "textarea";
  default: unknown;
  label: SettingEntry["label"];
  description?: SettingEntry["description"];
  min?: number;
  max?: number;
  step?: number;
  options?: SettingEntry["options"];
}

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
    case "number":
      return "number";
    case "toggle":
      return "toggle";
    case "select":
      return "select";
    case "textarea":
      return "textarea";
  }
}

function schemaFor(spec: PluginUserSettingSpec): z.ZodType {
  switch (spec.type) {
    case "text":
    case "textarea":
      return z.string();
    case "number":
      return z.number();
    case "toggle":
      return z.boolean();
    case "select": {
      const values = (spec.options ?? []).map((o) => o.value);
      if (values.length === 0) return z.string();
      return z.enum(values as [string, ...string[]]);
    }
  }
}
