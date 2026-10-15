import {
  DEFAULT_LOCALE,
  type PluginPack,
  type PluginSummary,
  type WorldPluginPlan,
} from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";

export type { PluginPack } from "@covel/shared";

export interface PluginGroup {
  id: string;
  label: string;
  plugins: PluginSummary[];
}

/**
 * All locale values of an I18nText joined — used to build a locale-agnostic
 * search index so a query matches regardless of which language the value was
 * authored in (an English UI should still match an English display name).
 */
function i18nAllText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .join(" ");
  }
  return "";
}

export function textValue(
  value: unknown,
  locale: string = DEFAULT_LOCALE,
): string {
  return resolveDisplayText(value, locale);
}

export function applyPluginPackSelection(
  current: ReadonlySet<string>,
  pack: PluginPack,
  plugins: readonly PluginSummary[],
  lockedPluginIds: ReadonlySet<string>,
): Set<string> {
  const available = new Set(plugins.map((plugin) => plugin.id));
  const next = new Set(current);
  for (const pluginId of pack.requested) {
    if (available.has(pluginId)) next.add(pluginId);
  }
  for (const pluginId of lockedPluginIds) next.add(pluginId);
  return next;
}

export function defaultSelectedPluginIds(
  plan: WorldPluginPlan | null,
): Set<string> {
  return new Set(plan?.defaultPluginIds ?? []);
}

export function collectPluginTags(plugins: readonly PluginSummary[]): string[] {
  return [...new Set(plugins.flatMap((plugin) => plugin.tags ?? []))].sort(
    (a, b) => a.localeCompare(b),
  );
}

/** Tags Covel derives from a package's contents, by translation key. */
const DERIVED_TAG_KEYS: Readonly<Record<string, string>> = {
  "cost:llm": "costLlm",
  "cost:function": "costFunction",
  "ui:right-panel": "uiRightPanel",
  "ui:message-block": "uiMessageBlock",
  "ui:manual-action": "uiManualAction",
};

/**
 * A tag in the player's words: a derived tag is translated, a tag the author
 * wrote is shown as written.
 */
export function pluginTagLabel(
  tag: string,
  t: (key: string) => string,
): string {
  const key = DERIVED_TAG_KEYS[tag];
  return key ? t(`session.pluginTags.${key}`) : tag;
}

/**
 * Plugins grouped by whether they call a model (their `cost:*` tag), and a
 * plugin without one under its first tag. `labelForGroup` gets that tag, or
 * `undefined` for the plugins without any.
 */
export function groupPlugins(
  plugins: readonly PluginSummary[],
  labelForGroup: (tag: string | undefined) => string,
): PluginGroup[] {
  const grouped = new Map<string, PluginSummary[]>();
  for (const plugin of plugins) {
    const tag =
      plugin.tags?.find((item) => item.startsWith("cost:")) ?? plugin.tags?.[0];
    const groupId = tag === undefined ? "untagged" : `tag:${tag}`;
    const list = grouped.get(groupId) ?? [];
    list.push(plugin);
    grouped.set(groupId, list);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) =>
      a === "untagged" ? 1 : b === "untagged" ? -1 : a.localeCompare(b),
    )
    .map(([id, groupPlugins]) => ({
      id,
      label: labelForGroup(id === "untagged" ? undefined : id.slice(4)),
      plugins: groupPlugins.slice().sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export function filterPlugins(
  plugins: readonly PluginSummary[],
  query: string,
  activeTags: ReadonlySet<string>,
): PluginSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return plugins.filter((pkg) => {
    const pkgTags = new Set(pkg.tags ?? []);
    if (
      activeTags.size > 0 &&
      ![...activeTags].every((tag) => pkgTags.has(tag))
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    const haystack = [
      pkg.id,
      i18nAllText(pkg.displayName),
      i18nAllText(pkg.description),
      ...(pkg.tags ?? []),
      ...pkg.provides.map((p) => (typeof p === "string" ? p : p.contract)),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function recommendationReason(
  pkg: PluginSummary,
  plan: WorldPluginPlan | null,
  selectedPack: PluginPack | null,
  labels: {
    locale: string;
    requiredByWorld: string;
    requestedByWorld: string;
    packOptional: string;
  },
): string | null {
  const policy = plan?.policy;
  // "Required" is reserved for providers of a contract the world requires;
  // a plugin of the world's `plus` is only its default selection.
  const provided = pkg.provides.map((entry) =>
    typeof entry === "string" ? entry : entry.contract,
  );
  if (policy?.requires.some((contract) => provided.includes(contract))) {
    return labels.requiredByWorld;
  }
  if (policy?.plus.includes(pkg.id)) {
    return labels.requestedByWorld;
  }
  if (selectedPack?.requested.includes(pkg.id)) {
    return textValue(selectedPack.label, labels.locale);
  }
  if (selectedPack?.recommended.includes(pkg.id)) {
    return labels.packOptional;
  }
  return null;
}
