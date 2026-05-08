import type { I18nText } from "@covel/shared";
import type { PackageSummary, WorldRecord } from "@/services/api.js";

export interface PluginPack {
  id: string;
  label: I18nText;
  labelKey?: string;
  description?: I18nText;
  descriptionKey?: string;
  plugins: string[];
  optionalPlugins: string[];
  excludedPlugins: string[];
  tags: string[];
  reason?: I18nText;
  source: "builtin" | "world";
}

export interface WorldPluginPolicy {
  preset?: string;
  packs: PluginPack[];
  preferTags: string[];
  avoidTags: string[];
  requireCapabilities: string[];
  requiredPlugins: string[];
  recommendedPlugins: string[];
  excludedPlugins: string[];
}

export interface PluginGroup {
  id: string;
  label: string;
  packages: PackageSummary[];
}

export const BUILTIN_PLUGIN_PACKS: readonly PluginPack[] = [
  {
    id: "traditional-story",
    label: "Traditional Story",
    labelKey: "session.pluginPacks.traditional-story.label",
    description:
      "Narrator, suggestions, codex, and relationship memory for long-form exploration.",
    descriptionKey: "session.pluginPacks.traditional-story.description",
    plugins: [
      "pregame",
      "world-init",
      "char-creator",
      "narrator",
      "guide",
      "codex",
      "npc-graph",
      "player-identity",
      "living-world-rules",
    ],
    optionalPlugins: ["memory"],
    excludedPlugins: [
      "chat-mode-narrator",
      "scene-cast",
      "scene-prompts",
      "branch-reply",
    ],
    tags: ["mode:traditional-story"],
    source: "builtin",
  },
  {
    id: "dialogue-mode",
    label: "Dialogue Mode",
    labelKey: "session.pluginPacks.dialogue-mode.label",
    description:
      "Dialogue-first narration, scene cast state, quick replies, and character profiles.",
    descriptionKey: "session.pluginPacks.dialogue-mode.description",
    plugins: [
      "pregame",
      "world-init",
      "char-creator",
      "chat-mode-narrator",
      "scene-cast",
      "scene-prompts",
      "character-blueprint",
      "character-presence",
      "player-identity",
      "living-world-rules",
      "branch-reply",
    ],
    optionalPlugins: ["memory", "npc-graph"],
    excludedPlugins: ["narrator", "guide", "codex"],
    tags: ["mode:dialogue"],
    source: "builtin",
  },
  {
    id: "low-cost",
    label: "Low Cost",
    labelKey: "session.pluginPacks.low-cost.label",
    description:
      "Keeps the core loop and function plugins while reducing downstream LLM calls.",
    descriptionKey: "session.pluginPacks.low-cost.description",
    plugins: [
      "pregame",
      "world-init",
      "char-creator",
      "narrator",
      "player-identity",
      "living-world-rules",
    ],
    optionalPlugins: ["memory"],
    excludedPlugins: ["guide", "codex", "scene-prompts"],
    tags: ["cost:function"],
    source: "builtin",
  },
];

export function textValue(value: unknown, locale = "zh-CN"): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const direct = record[locale];
    if (typeof direct === "string") return direct;
    const language = locale.split("-")[0];
    const languageValue = record[language];
    if (typeof languageValue === "string") return languageValue;
    const en = record["en-US"] ?? record.en;
    if (typeof en === "string") return en;
    const first = Object.values(record).find(
      (item) => typeof item === "string",
    );
    return typeof first === "string" ? first : "";
  }
  return "";
}

export function stringArrayFromMetadata(
  metadata: WorldRecord["metadata"] | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function readWorldPacks(value: unknown): PluginPack[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      label:
        typeof item.label === "string" ||
        (item.label && typeof item.label === "object")
          ? (item.label as I18nText)
          : "",
      description:
        typeof item.description === "string" ||
        (item.description && typeof item.description === "object")
          ? (item.description as I18nText)
          : undefined,
      plugins: normalizeStringArray(item.plugins),
      optionalPlugins: normalizeStringArray(item.optionalPlugins),
      excludedPlugins: normalizeStringArray(item.excludedPlugins),
      tags: normalizeStringArray(item.tags),
      reason:
        typeof item.reason === "string" ||
        (item.reason && typeof item.reason === "object")
          ? (item.reason as I18nText)
          : undefined,
      source: "world" as const,
    }))
    .filter((pack) => pack.id.length > 0);
}

export function readWorldPluginPolicy(world: WorldRecord): WorldPluginPolicy {
  const raw =
    world.metadata?.pluginPolicy &&
    typeof world.metadata.pluginPolicy === "object" &&
    !Array.isArray(world.metadata.pluginPolicy)
      ? (world.metadata.pluginPolicy as Record<string, unknown>)
      : {};

  return {
    preset: typeof raw.preset === "string" ? raw.preset : undefined,
    packs: readWorldPacks(raw.packs),
    preferTags: normalizeStringArray(raw.preferTags),
    avoidTags: normalizeStringArray(raw.avoidTags),
    requireCapabilities: normalizeStringArray(raw.requireCapabilities),
    requiredPlugins: [
      ...new Set([
        ...stringArrayFromMetadata(world.metadata, "requiredPlugins"),
        ...normalizeStringArray(raw.requiredPlugins),
      ]),
    ],
    recommendedPlugins: [
      ...new Set([
        ...stringArrayFromMetadata(world.metadata, "recommendedPlugins"),
        ...normalizeStringArray(raw.recommendedPlugins),
      ]),
    ],
    excludedPlugins: [
      ...new Set([
        ...stringArrayFromMetadata(world.metadata, "excludedPlugins"),
        ...normalizeStringArray(raw.excludedPlugins),
      ]),
    ],
  };
}

export function pluginPacksForWorld(world: WorldRecord): PluginPack[] {
  const policy = readWorldPluginPolicy(world);
  const worldPackIds = new Set(policy.packs.map((pack) => pack.id));
  return [
    ...policy.packs,
    ...BUILTIN_PLUGIN_PACKS.filter((pack) => !worldPackIds.has(pack.id)),
  ];
}

export function selectedPackForWorld(world: WorldRecord): PluginPack | null {
  const policy = readWorldPluginPolicy(world);
  if (!policy.preset) return null;
  return (
    pluginPacksForWorld(world).find((pack) => pack.id === policy.preset) ?? null
  );
}

export function applyPluginPackSelection(
  current: ReadonlySet<string>,
  pack: PluginPack,
  packages: readonly PackageSummary[],
  lockedPluginIds: ReadonlySet<string>,
): Set<string> {
  const available = new Set(packages.map((pkg) => pkg.name));
  const next = new Set(current);
  for (const pluginId of pack.excludedPlugins) {
    if (!lockedPluginIds.has(pluginId)) next.delete(pluginId);
  }
  for (const pluginId of [...pack.plugins, ...pack.optionalPlugins]) {
    if (available.has(pluginId)) next.add(pluginId);
  }
  for (const pluginId of lockedPluginIds) next.add(pluginId);
  return next;
}

export function defaultSelectedPluginIdsForWorld(
  world: WorldRecord,
  packages: readonly PackageSummary[],
  isLockedCorePackage: (pkg: PackageSummary) => boolean,
): Set<string> {
  const policy = readWorldPluginPolicy(world);
  const selectedPack = selectedPackForWorld(world);
  const required = new Set(policy.requiredPlugins);
  const recommended = new Set(policy.recommendedPlugins);
  const excluded = new Set(policy.excludedPlugins);
  const available = new Set(packages.map((pkg) => pkg.name));

  if (selectedPack) {
    for (const pluginId of selectedPack.plugins) required.add(pluginId);
    for (const pluginId of selectedPack.optionalPlugins) {
      recommended.add(pluginId);
    }
    for (const pluginId of selectedPack.excludedPlugins) excluded.add(pluginId);
  }

  for (const pkg of packages) {
    const tags = new Set(pkg.tags ?? []);
    const capabilities = new Set(pkg.capabilities ?? []);
    if (policy.preferTags.some((tag) => tags.has(tag))) {
      recommended.add(pkg.name);
    }
    if (policy.avoidTags.some((tag) => tags.has(tag))) excluded.add(pkg.name);
    if (
      policy.requireCapabilities.some((capability) =>
        capabilities.has(capability),
      )
    ) {
      recommended.add(pkg.name);
    }
  }

  const hasWorldPolicy =
    required.size > 0 ||
    recommended.size > 0 ||
    excluded.size > 0 ||
    policy.preferTags.length > 0 ||
    policy.avoidTags.length > 0 ||
    policy.requireCapabilities.length > 0 ||
    Boolean(selectedPack);

  if (hasWorldPolicy) {
    return new Set(
      packages
        .filter(
          (pkg) =>
            isLockedCorePackage(pkg) ||
            required.has(pkg.name) ||
            recommended.has(pkg.name),
        )
        .filter((pkg) => available.has(pkg.name) && !excluded.has(pkg.name))
        .map((pkg) => pkg.name),
    );
  }

  return new Set(
    packages
      .filter((pkg) => pkg.enabled || isLockedCorePackage(pkg))
      .map((pkg) => pkg.name),
  );
}

export function collectPluginTags(
  packages: readonly PackageSummary[],
): string[] {
  return [...new Set(packages.flatMap((pkg) => pkg.tags ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function groupIdForPackage(pkg: PackageSummary): string {
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
  packages: readonly PackageSummary[],
  labelForGroup: (groupId: string) => string,
): PluginGroup[] {
  const grouped = new Map<string, PackageSummary[]>();
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
      packages: groupPackages
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export function filterPluginPackages(
  packages: readonly PackageSummary[],
  query: string,
  activeTags: ReadonlySet<string>,
): PackageSummary[] {
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
      pkg.name,
      textValue(pkg.displayName),
      textValue(pkg.description),
      ...(pkg.tags ?? []),
      ...(pkg.capabilities ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function recommendationReason(
  pkg: PackageSummary,
  world: WorldRecord,
  selectedPack: PluginPack | null,
  labels: {
    locale: string;
    requiredByWorld: string;
    packOptional: string;
    recommendedByWorld: string;
  },
): string | null {
  const policy = readWorldPluginPolicy(world);
  if (policy.requiredPlugins.includes(pkg.name)) {
    return labels.requiredByWorld;
  }
  if (selectedPack?.plugins.includes(pkg.name)) {
    return textValue(selectedPack.label, labels.locale);
  }
  if (selectedPack?.optionalPlugins.includes(pkg.name)) {
    return labels.packOptional;
  }
  if (policy.recommendedPlugins.includes(pkg.name)) {
    return labels.recommendedByWorld;
  }
  const tags = new Set(pkg.tags ?? []);
  const matchedTag = policy.preferTags.find((tag) => tags.has(tag));
  if (matchedTag) return matchedTag;
  const capabilities = new Set(pkg.capabilities ?? []);
  const matchedCapability = policy.requireCapabilities.find((capability) =>
    capabilities.has(capability),
  );
  return matchedCapability ?? null;
}
