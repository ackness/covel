import type { SettingEntry, SettingsStoreApi } from "@covel/settings";
import { DEFAULT_LOCALE, resolveI18nText, type I18nText } from "@covel/shared";
import i18n from "@/i18n";
import { resolveSettingEntryText } from "./framework-i18n.js";

export type NavNodeKind = "header" | "group" | "plugin" | "subgroup";

export interface NavNode {
  id: string;
  label: string;
  /** `header` nodes only title a group of panes and cannot be selected. */
  kind: NavNodeKind;
  /** Registered entries owned by this pane, also used for search and deep links. */
  children: SettingEntry[];
  /** Parent id for sub-nodes (rendered indented in the left nav). */
  parentId?: string;
}

const PACKAGES_NODE_ID = "packages";
const APPEARANCE_NODE_ID = "appearance";
const GENERAL_NODE_ID = "general";
const ADVANCED_NODE_ID = "advanced";
const GENERAL_HEADER_ID = "group.general";
const SAVES_HEADER_ID = "group.saves";
const ADVANCED_HEADER_ID = "group.advanced";

/**
 * Theme keys are registered under `general` so the store owns their values,
 * but they render in the purpose-built Appearance pane instead of as loose
 * widgets — listing them in both places would give the player two different
 * controls for the same setting.
 */
const APPEARANCE_KEYS = new Set([
  "ui.appearance",
  "ui.scheme",
  "ui.themeManager",
]);

/** Language and music, then the reading section. */
const PREFERENCE_KEYS = [
  "ui.locale",
  "audio.musicEnabled",
  "audio.musicVolume",
  "ui.instantText",
  "ui.liveOutput",
  "ui.expandTurnUpdates",
] as const;
/** The part of the preferences pane that is about reading the story. */
export const READING_KEYS: ReadonlySet<string> = new Set([
  "ui.instantText",
  "ui.liveOutput",
  "ui.expandTurnUpdates",
]);
export const DEVELOPER_MODE_KEY = "ui.developerView";
/** Operator and author options, in the order the Advanced pane shows them. */
const ADVANCED_KEYS = [
  DEVELOPER_MODE_KEY,
  "diagnostics.traceRetention",
  "ui.chatMessageWindow",
  "world.authoringIdleTimeoutSeconds",
] as const;
const INTERNAL_KEYS = new Set(["ui.onboardedVersion"]);

const OPERATOR_ACCESS_NODE_ID = "operator-access";
const RAW_CONFIG_NODE_ID = "raw-config";
const MEDIA_LIBRARY_NODE_ID = "media-library";
const DATA_NODE_ID = "data";
function navigationLabels(locale: string) {
  const t = i18n.getFixedT(locale);
  return {
    headers: {
      general: t("settings.groupGeneral", "General"),
      llm: t("settings.groupLlm", "Models"),
      plugin: t("settings.groupPlugins", "Plugins"),
      saves: t("settings.groupData", "Saves & data"),
      advanced: t("settings.groupAdvanced", "Advanced"),
      desktop: t("settings.groupDesktop", "Desktop"),
    },
    llmSubnodes: [
      { id: "llm.slots", label: t("settings.llmSlots", "AI roles") },
      {
        id: "llm.providers",
        label: t("settings.llmPresets", "Providers & keys"),
      },
      {
        id: "llm.advanced",
        label: t("settings.llmAdvanced", "Generation"),
      },
    ],
    preferences: t("settings.preferencesNavLabel", "Preferences"),
    appearance: t("settings.appearanceNavLabel", "Appearance"),
    data: t("settings.dataNavLabel", "Import, backup & reset"),
    rawConfig: t("settings.rawConfigNavLabel", "Configuration file"),
    mediaLibrary: t("settings.mediaLibraryNavLabel", "Stored media"),
    operatorAccess: t("settings.operatorAccessNavLabel", "Operator access"),
    advancedOptions: t("settings.advancedNavLabel", "Options"),
    packages: t("settings.packages.navLabel", "Install & manage"),
  };
}

interface BuildNavOptions {
  readonly includeDesktop?: boolean;
  /** False where the server does not check an operator token. Defaults to true. */
  readonly includeOperatorAccess?: boolean;
  /** False on a hosted server, which offers no media library. Defaults to true. */
  readonly includeMediaLibrary?: boolean;
  /** Shows the settings that only authors and troubleshooting need. */
  readonly developerMode?: boolean;
  readonly locale?: string;
  readonly pluginDisplayNames?: Readonly<Record<string, I18nText | undefined>>;
}

/**
 * Build the left-nav tree.
 *
 * Five groups: General, Models, Plugins, Saves & data and Advanced, plus
 * Desktop in the desktop app. Nodes are a flat list rather than a tree to keep
 * the renderer simple; sub-nodes carry `parentId`. The pane for most nodes is
 * purpose-built; a node's `children` are the registered entries it owns, used
 * for search and deep links.
 */
export function buildNavTree(
  store: SettingsStoreApi,
  opts: BuildNavOptions = {},
): NavNode[] {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const labels = navigationLabels(locale);
  const all = store.listEntries();
  const byKey = new Map(all.map((entry) => [entry.key, entry] as const));
  const pick = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      const entry = byKey.get(key);
      return entry ? [entry] : [];
    });
  const plain = (entry: SettingEntry) =>
    entry.group === "general" &&
    entry.widget !== "custom" &&
    !APPEARANCE_KEYS.has(entry.key) &&
    !INTERNAL_KEYS.has(entry.key);
  // Anything else registered as a plain general setting still shows up, under
  // Advanced, so a new entry is never unreachable.
  const knownKeys = new Set<string>([...PREFERENCE_KEYS, ...ADVANCED_KEYS]);
  const extraAdvanced = all.filter(
    (entry) => plain(entry) && !knownKeys.has(entry.key),
  );
  const nodes: NavNode[] = [];

  nodes.push({
    id: GENERAL_HEADER_ID,
    label: labels.headers.general,
    kind: "header",
    children: [],
  });
  nodes.push({
    id: GENERAL_NODE_ID,
    label: labels.preferences,
    kind: "subgroup",
    parentId: GENERAL_HEADER_ID,
    children: pick(PREFERENCE_KEYS),
  });
  nodes.push({
    id: APPEARANCE_NODE_ID,
    label: labels.appearance,
    kind: "subgroup",
    parentId: GENERAL_HEADER_ID,
    children: all.filter((entry) => APPEARANCE_KEYS.has(entry.key)),
  });

  nodes.push({
    id: "llm",
    label: labels.headers.llm,
    kind: "header",
    children: [],
  });
  for (const sub of labels.llmSubnodes) {
    nodes.push({
      id: sub.id,
      label: sub.label,
      kind: "subgroup",
      parentId: "llm",
      children: all.filter((entry) => {
        if (sub.id === "llm.providers") {
          return (
            entry.key.startsWith("keys.") ||
            ["llm.providers", "llm.providerPriceMultipliers"].includes(
              entry.key,
            )
          );
        }
        if (sub.id === "llm.advanced")
          return entry.key === "llm.paramOverrides";
        // Capability overrides are for authors and troubleshooting.
        return (
          entry.key === "llm.slotConfig" ||
          (opts.developerMode === true &&
            entry.key === "llm.capabilityOverrides")
        );
      }),
    });
  }

  const byPlugin = new Map<string, SettingEntry[]>();
  for (const entry of all) {
    if (entry.group !== "plugin" || !entry.pluginId) continue;
    const bucket = byPlugin.get(entry.pluginId) ?? [];
    bucket.push(entry);
    byPlugin.set(entry.pluginId, bucket);
  }
  nodes.push({
    id: "plugin",
    label: labels.headers.plugin,
    kind: "header",
    children: [],
  });
  nodes.push({
    id: PACKAGES_NODE_ID,
    label: labels.packages,
    kind: "subgroup",
    parentId: "plugin",
    children: all.filter((entry) => entry.key === "trust.sources"),
  });
  for (const [pluginId, pluginEntries] of byPlugin) {
    nodes.push({
      id: `plugin.${pluginId}`,
      label:
        resolveI18nText(opts.pluginDisplayNames?.[pluginId], locale) ??
        pluginId,
      kind: "plugin",
      parentId: "plugin",
      children: pluginEntries,
    });
  }

  nodes.push({
    id: SAVES_HEADER_ID,
    label: labels.headers.saves,
    kind: "header",
    children: [],
  });
  nodes.push({
    id: DATA_NODE_ID,
    label: labels.data,
    kind: "subgroup",
    parentId: SAVES_HEADER_ID,
    children: all.filter((entry) => entry.group === "data"),
  });
  if (opts.includeMediaLibrary !== false) {
    nodes.push({
      id: MEDIA_LIBRARY_NODE_ID,
      label: labels.mediaLibrary,
      kind: "subgroup",
      parentId: SAVES_HEADER_ID,
      children: [],
    });
  }

  nodes.push({
    id: ADVANCED_HEADER_ID,
    label: labels.headers.advanced,
    kind: "header",
    children: [],
  });
  nodes.push({
    id: ADVANCED_NODE_ID,
    label: labels.advancedOptions,
    kind: "subgroup",
    parentId: ADVANCED_HEADER_ID,
    children: [...pick(ADVANCED_KEYS), ...extraAdvanced],
  });
  nodes.push({
    id: RAW_CONFIG_NODE_ID,
    label: labels.rawConfig,
    kind: "subgroup",
    parentId: ADVANCED_HEADER_ID,
    children: [],
  });
  // Pure-web hosted deployments need an explicit browser-local credential
  // entry point before any operator-gated management request can succeed. A
  // self-tier server ignores the header, so the caller leaves the pane out
  // once that server has said so.
  if (opts.includeOperatorAccess !== false) {
    nodes.push({
      id: OPERATOR_ACCESS_NODE_ID,
      label: labels.operatorAccess,
      kind: "subgroup",
      parentId: ADVANCED_HEADER_ID,
      children: [],
    });
  }

  if (opts.includeDesktop) {
    nodes.push({
      id: "desktop",
      label: labels.headers.desktop,
      kind: "group",
      children: all.filter((entry) => entry.group === "desktop"),
    });
  }
  return nodes;
}

export {
  ADVANCED_NODE_ID,
  APPEARANCE_NODE_ID,
  DATA_NODE_ID,
  GENERAL_NODE_ID,
  MEDIA_LIBRARY_NODE_ID,
  OPERATOR_ACCESS_NODE_ID,
  PACKAGES_NODE_ID,
  RAW_CONFIG_NODE_ID,
};

/** Resolve current pane IDs and composite setting keys. */
export function resolveSettingsNode(
  nodes: readonly NavNode[],
  key: string,
): NavNode | undefined {
  const target = key.startsWith("keys.") ? "llm.providers" : key;
  const exact = nodes.find((node) => node.id === target);
  if (exact) {
    return exact.kind === "header"
      ? nodes.find((node) => node.parentId === exact.id)
      : exact;
  }
  return nodes.find((node) =>
    node.children.some(
      (entry) => entry.key === target || entry.key.startsWith(`${target}.`),
    ),
  );
}

export function filterNav(
  nodes: NavNode[],
  query: string,
  locale: string = DEFAULT_LOCALE,
): NavNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  // Keep parent nodes whose subgroups match; keep children that match.
  const result = nodes.filter((node) => {
    const labelHit = `${node.id} ${node.label}`.toLowerCase().includes(q);
    const childHit = node.children.some((e) =>
      (
        e.key +
        " " +
        resolveSettingEntryText(e, "label", locale) +
        " " +
        resolveSettingEntryText(e, "description", locale)
      )
        .toLowerCase()
        .includes(q),
    );
    // Also surface children of siblings when searching.
    const parentHit = node.parentId
      ? (nodes
          .find((n) => n.id === node.parentId)
          ?.label.toLowerCase()
          .includes(q) ?? false)
      : false;
    return labelHit || childHit || parentHit;
  });
  // If any subgroup matched, keep its parent too for orientation.
  const parents = new Set(
    result.filter((n) => n.parentId).map((n) => n.parentId!),
  );
  for (const parentId of parents) {
    if (!result.find((n) => n.id === parentId)) {
      const parentNode = nodes.find((n) => n.id === parentId);
      if (parentNode) result.unshift(parentNode);
    }
  }
  return result;
}
