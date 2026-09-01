import type {
  SettingEntry,
  SettingGroup,
  SettingsStoreApi,
} from "@covel/settings";
import { DEFAULT_LOCALE, resolveI18nText, type I18nText } from "@covel/shared";
import i18n from "@/i18n";
import { resolveSettingEntryText } from "./framework-i18n.js";

export type NavNodeKind = "group" | "plugin" | "subgroup";

export interface NavNode {
  id: string;
  label: string;
  kind: NavNodeKind;
  /** Registered entries rendered in this node (empty if node uses a custom pane). */
  children: SettingEntry[];
  /** Parent id for sub-nodes (rendered indented in the left nav). */
  parentId?: string;
}

const GROUP_ORDER: SettingGroup[] = [
  "general",
  "llm",
  "plugin",
  "desktop",
  "data",
];

const PACKAGES_NODE_ID = "packages";
const APPEARANCE_NODE_ID = "appearance";

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
const OPERATOR_ACCESS_NODE_ID = "operator-access";
function navigationLabels(locale: string) {
  const t = i18n.getFixedT(locale);
  return {
    groups: {
      general: t("settings.groupGeneral", "General"),
      llm: t("settings.groupLlm", "LLM"),
      plugin: t("settings.groupPlugins", "Plugins"),
      desktop: t("settings.groupDesktop", "Desktop"),
      data: t("settings.groupData", "Data"),
    } satisfies Record<SettingGroup, string>,
    llmSubnodes: [
      { id: "llm.slots", label: t("settings.llmSlots", "Model Roles") },
      {
        id: "llm.providers",
        label: t("settings.llmPresets", "Providers & Models"),
      },
      {
        id: "llm.advanced",
        label: t("settings.llmAdvanced", "Generation"),
      },
    ],
    appearance: t("settings.appearanceNavLabel", "Appearance"),
    operatorAccess: t("settings.operatorAccessNavLabel", "Operator Access"),
    packages: t("settings.packages.navLabel", "Import Packages"),
  };
}

interface BuildNavOptions {
  readonly includeDesktop?: boolean;
  readonly locale?: string;
  readonly pluginDisplayNames?: Readonly<Record<string, I18nText | undefined>>;
}

/**
 * Build the left-nav tree.
 *
 * Nodes are a flat list rather than a tree to keep the renderer simple;
 * sub-nodes carry `parentId` and render indented. LLM always expands into
 * 3 fixed sub-nodes (model roles / providers and models / generation) backed by
 * purpose-built panes, not widget dispatch.
 */
export function buildNavTree(
  store: SettingsStoreApi,
  opts: BuildNavOptions = {},
): NavNode[] {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const labels = navigationLabels(locale);
  const all = store.listEntries();
  const byGroup = new Map<SettingGroup, SettingEntry[]>();
  for (const e of all) {
    const bucket = byGroup.get(e.group) ?? [];
    bucket.push(e);
    byGroup.set(e.group, bucket);
  }
  const nodes: NavNode[] = [];
  for (const group of GROUP_ORDER) {
    const entries = byGroup.get(group) ?? [];
    if (group === "llm") {
      nodes.push({
        id: "llm",
        label: labels.groups.llm,
        kind: "group",
        children: [],
      });
      for (const sub of labels.llmSubnodes) {
        nodes.push({
          id: sub.id,
          label: sub.label,
          kind: "subgroup",
          parentId: "llm",
          children: [],
        });
      }
    } else if (group === "plugin") {
      const byPlugin = new Map<string, SettingEntry[]>();
      for (const e of entries) {
        if (!e.pluginId) continue;
        const bucket = byPlugin.get(e.pluginId) ?? [];
        bucket.push(e);
        byPlugin.set(e.pluginId, bucket);
      }
      if (byPlugin.size > 0) {
        nodes.push({
          id: "plugin",
          label: labels.groups.plugin,
          kind: "group",
          children: [],
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
      }
    } else if (group === "desktop") {
      if (opts.includeDesktop) {
        nodes.push({
          id: "desktop",
          label: labels.groups.desktop,
          kind: "group",
          children: entries,
        });
      }
    } else if (group === "data") {
      nodes.push({
        id: "data",
        label: labels.groups.data,
        kind: "group",
        children: entries,
      });
    } else if (group === "general") {
      const generalEntries = entries.filter((e) => !APPEARANCE_KEYS.has(e.key));
      if (generalEntries.length > 0) {
        nodes.push({
          id: group,
          label: labels.groups.general,
          kind: "group",
          children: generalEntries,
        });
      }
      nodes.push({
        id: APPEARANCE_NODE_ID,
        label: labels.appearance,
        kind: "group",
        children: [],
      });
    } else if (entries.length > 0) {
      nodes.push({
        id: group,
        label: labels.groups[group],
        kind: "group",
        children: entries,
      });
    }
  }
  // Pure-web hosted deployments need an explicit browser-local credential
  // entry point before any operator-gated management request can succeed.
  // Append it after the normal groups so self-tier users keep their existing
  // default Settings pane; those servers simply ignore the optional header.
  nodes.push({
    id: OPERATOR_ACCESS_NODE_ID,
    label: labels.operatorAccess,
    kind: "group",
    children: [],
  });
  // Virtual node for package import (UI-only, no registered SettingEntry).
  nodes.push({
    id: PACKAGES_NODE_ID,
    label: labels.packages,
    kind: "group",
    children: [],
  });
  return nodes;
}

export { APPEARANCE_NODE_ID, OPERATOR_ACCESS_NODE_ID, PACKAGES_NODE_ID };

export function filterNav(
  nodes: NavNode[],
  query: string,
  locale: string = DEFAULT_LOCALE,
): NavNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  // Keep parent nodes whose subgroups match; keep children that match.
  const result = nodes.filter((node) => {
    const labelHit = node.label.toLowerCase().includes(q);
    const childHit = node.children.some((e) =>
      (e.key + " " + resolveSettingEntryText(e, "label", locale))
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
