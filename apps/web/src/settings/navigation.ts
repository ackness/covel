import type {
  SettingEntry,
  SettingGroup,
  SettingsStoreApi,
} from "@covel/shared";

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
const PACKAGES_LABEL = { "zh-CN": "导入包", "en-US": "Import Packages" };

const GROUP_LABELS: Record<SettingGroup, { "zh-CN": string; "en-US": string }> =
  {
    general: { "zh-CN": "通用", "en-US": "General" },
    llm: { "zh-CN": "模型", "en-US": "LLM" },
    plugin: { "zh-CN": "插件", "en-US": "Plugins" },
    desktop: { "zh-CN": "桌面", "en-US": "Desktop" },
    data: { "zh-CN": "数据", "en-US": "Data" },
  };

const LLM_SUBNODES: Array<{ id: string; label: { "zh-CN": string; "en-US": string } }> =
  [
    { id: "llm.slots", label: { "zh-CN": "Slots", "en-US": "Slots" } },
    { id: "llm.keys", label: { "zh-CN": "API 密钥", "en-US": "API Keys" } },
    {
      id: "llm.presets",
      label: { "zh-CN": "自定义 Preset", "en-US": "Custom Presets" },
    },
    {
      id: "llm.advanced",
      label: { "zh-CN": "高级参数", "en-US": "Advanced" },
    },
  ];

function groupLabel(group: SettingGroup, locale: string): string {
  const l = GROUP_LABELS[group];
  return locale.startsWith("en") ? l["en-US"] : l["zh-CN"];
}

function labelToString(
  label: SettingEntry["label"] | string | undefined,
  locale: string,
): string {
  if (!label) return "";
  if (typeof label === "string") return label;
  return (
    label[locale] ?? label["en-US"] ?? Object.values(label)[0] ?? ""
  );
}

interface BuildNavOptions {
  readonly includeDesktop?: boolean;
  readonly locale?: string;
}

/**
 * Build the left-nav tree.
 *
 * Nodes are a flat list rather than a tree to keep the renderer simple;
 * sub-nodes carry `parentId` and render indented. LLM always expands into
 * 4 fixed sub-nodes (Slots / Keys / Presets / Advanced) which are backed by
 * purpose-built panes, not widget dispatch.
 */
export function buildNavTree(
  store: SettingsStoreApi,
  opts: BuildNavOptions = {},
): NavNode[] {
  const locale = opts.locale ?? "zh-CN";
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
        label: groupLabel("llm", locale),
        kind: "group",
        children: [],
      });
      for (const sub of LLM_SUBNODES) {
        nodes.push({
          id: sub.id,
          label: locale === "en-US" ? sub.label["en-US"] : sub.label["zh-CN"],
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
          label: groupLabel("plugin", locale),
          kind: "group",
          children: [],
        });
        for (const [pluginId, pluginEntries] of byPlugin) {
          nodes.push({
            id: `plugin.${pluginId}`,
            label: pluginId,
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
          label: groupLabel("desktop", locale),
          kind: "group",
          children: entries,
        });
      }
    } else if (group === "data") {
      nodes.push({
        id: "data",
        label: groupLabel("data", locale),
        kind: "group",
        children: entries,
      });
    } else if (entries.length > 0) {
      nodes.push({
        id: group,
        label: groupLabel(group, locale),
        kind: "group",
        children: entries,
      });
    }
  }
  // Virtual node for package import (UI-only, no registered SettingEntry).
  nodes.push({
    id: PACKAGES_NODE_ID,
    label: locale.startsWith("en") ? PACKAGES_LABEL["en-US"] : PACKAGES_LABEL["zh-CN"],
    kind: "group",
    children: [],
  });
  return nodes;
}

export { PACKAGES_NODE_ID };

export function filterNav(
  nodes: NavNode[],
  query: string,
  locale = "zh-CN",
): NavNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  // Keep parent nodes whose subgroups match; keep children that match.
  const result = nodes.filter((node) => {
    const labelHit = node.label.toLowerCase().includes(q);
    const childHit = node.children.some((e) =>
      (e.key + " " + labelToString(e.label, locale))
        .toLowerCase()
        .includes(q),
    );
    // Also surface children of siblings when searching.
    const parentHit = node.parentId
      ? nodes.find((n) => n.id === node.parentId)?.label.toLowerCase().includes(q) ?? false
      : false;
    return labelHit || childHit || parentHit;
  });
  // If any subgroup matched, keep its parent too for orientation.
  const parents = new Set(result.filter((n) => n.parentId).map((n) => n.parentId!));
  for (const parentId of parents) {
    if (!result.find((n) => n.id === parentId)) {
      const parentNode = nodes.find((n) => n.id === parentId);
      if (parentNode) result.unshift(parentNode);
    }
  }
  return result;
}
