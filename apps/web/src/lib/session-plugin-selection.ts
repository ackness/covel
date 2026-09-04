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
  packages: PluginSummary[];
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
  packages: readonly PluginSummary[],
  lockedPluginIds: ReadonlySet<string>,
): Set<string> {
  const available = new Set(packages.map((pkg) => pkg.id));
  const next = new Set(current);
  for (const pluginId of pack.excludedPluginIds) {
    if (!lockedPluginIds.has(pluginId)) next.delete(pluginId);
  }
  for (const pluginId of [...pack.pluginIds, ...pack.optionalPluginIds]) {
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

export function collectPluginTags(
  packages: readonly PluginSummary[],
): string[] {
  return [...new Set(packages.flatMap((pkg) => pkg.tags ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function groupIdForPackage(pkg: PluginSummary): string {
  const tags = new Set(pkg.tags ?? []);
  if (tags.has("mode:dialogue")) return "dialogue";
  if (tags.has("mode:traditional-story")) return "traditional";
  if (tags.has("role:pre-game")) return "setup";
  if (tags.has("role:character")) return "characters";
  if (tags.has("role:memory") || tags.has("role:retrieval")) return "memory";
  if (tags.has("role:guide") || tags.has("role:quick-reply")) return "guidance";
  if (pkg.pluginType === "core-plugin") return "core";
  return "utility";
}

const GROUP_ORDER = [
  "core",
  "setup",
  "traditional",
  "dialogue",
  "characters",
  "memory",
  "guidance",
  "utility",
];

export function groupPluginPackages(
  packages: readonly PluginSummary[],
  labelForGroup: (groupId: string) => string,
): PluginGroup[] {
  const grouped = new Map<string, PluginSummary[]>();
  for (const pkg of packages) {
    const groupId = groupIdForPackage(pkg);
    const list = grouped.get(groupId) ?? [];
    list.push(pkg);
    grouped.set(groupId, list);
  }
  return [...grouped.entries()]
    .sort(
      ([a], [b]) =>
        (GROUP_ORDER.indexOf(a) === -1 ? 99 : GROUP_ORDER.indexOf(a)) -
          (GROUP_ORDER.indexOf(b) === -1 ? 99 : GROUP_ORDER.indexOf(b)) ||
        a.localeCompare(b),
    )
    .map(([id, groupPackages]) => ({
      id,
      label: labelForGroup(id),
      packages: groupPackages.slice().sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export function filterPluginPackages(
  packages: readonly PluginSummary[],
  query: string,
  activeTags: ReadonlySet<string>,
): PluginSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return packages.filter((pkg) => {
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
      ...(pkg.capabilities ?? []),
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
    packOptional: string;
    recommendedByWorld: string;
  },
): string | null {
  const policy = plan?.policy;
  if (policy?.requiredPluginIds.includes(pkg.id)) {
    return labels.requiredByWorld;
  }
  if (selectedPack?.pluginIds.includes(pkg.id)) {
    return textValue(selectedPack.label, labels.locale);
  }
  if (selectedPack?.optionalPluginIds.includes(pkg.id)) {
    return labels.packOptional;
  }
  if (policy?.recommendedPluginIds.includes(pkg.id)) {
    return labels.recommendedByWorld;
  }
  const tags = new Set(pkg.tags ?? []);
  const matchedTag = policy?.preferredTags.find((tag) => tags.has(tag));
  if (matchedTag) return matchedTag;
  const capabilities = new Set(pkg.capabilities ?? []);
  const matchedCapability = policy?.requiredCapabilities.find((capability) =>
    capabilities.has(capability),
  );
  return matchedCapability ?? null;
}
