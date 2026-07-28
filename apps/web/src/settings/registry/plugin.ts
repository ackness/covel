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
  /** Slot ids offered to `type: slot` settings. */
  slotIds: readonly string[] = [],
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
      options: spec.type === "slot" ? slotOptions(spec, slotIds) : spec.options,
      min: spec.min,
      max: spec.max,
      step: spec.step,
    });
  }
}

/**
 * Render a `slot` setting as a picker over the configured slots. The declared
 * default is included even when it has no `llm.toml` section yet, so the
 * current value never silently disappears from the list.
 */
function slotOptions(
  spec: PluginUserSettingSpec,
  slotIds: readonly string[],
): ReadonlyArray<{ value: string; label: string }> | undefined {
  const ids = new Set(slotIds);
  if (typeof spec.default === "string" && spec.default) ids.add(spec.default);
  if (ids.size === 0) return undefined;
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ value: id, label: id }));
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
    // A slot setting is a select over the configured slot ids — the options
    // are computed at registration time rather than declared in PLUGIN.md.
    case "slot":
      return "select";
  }
}

// Build a Zod schema that ENFORCES the declared constraints (min/max/options),
// not just renders a widget hint. An out-of-range value is rejected at `set()`.
function schemaFor(spec: PluginUserSettingSpec): z.ZodType {
  switch (spec.type) {
    case "text":
    case "textarea":
    // Deliberately NOT an enum over the rendered options: a player who adds a
    // slot to llm.toml after boot must still be able to select it.
    case "slot":
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
