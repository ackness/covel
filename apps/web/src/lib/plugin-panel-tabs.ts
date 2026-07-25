import type { UISlotEntry } from "@/services/api.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";

export interface PluginPanelSubPanel {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon: string;
  readonly spec: Record<string, unknown>;
}

export interface PluginPanelTabGroup {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon: string;
  readonly order: number;
  readonly subPanels: readonly PluginPanelSubPanel[];
}

export interface PluginPanelProviderGroup {
  readonly pluginId: string;
  readonly subs: readonly {
    readonly sub: PluginPanelSubPanel;
    readonly idx: number;
  }[];
}

export interface PluginPanelProviderPlan {
  readonly providers: readonly PluginPanelProviderGroup[];
  readonly multiProvider: boolean;
  readonly activeProviderId?: string;
  readonly activeProviderSubs: readonly {
    readonly sub: PluginPanelSubPanel;
    readonly idx: number;
  }[];
}

export function pluginShortLabel(
  pluginId: string,
  sessionPlugins: readonly {
    readonly id: string;
    readonly displayName: unknown;
  }[],
  locale: string,
): string {
  const plugin = sessionPlugins.find((p) => p.id === pluginId);
  if (!plugin) return pluginId;
  const label = resolveI18n(plugin.displayName, locale);
  return label.length > 0 ? label : pluginId;
}

export function compactTabLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) return "";

  const chars = Array.from(normalized);
  const hanChars = chars.filter((char) => /\p{Script=Han}/u.test(char));
  if (hanChars.length >= 2) return hanChars.slice(0, 2).join("");

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words
      .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 3);
  }

  return chars.slice(0, 4).join("");
}

export function groupShortLabel(
  group: PluginPanelTabGroup,
): string | undefined {
  return group.shortLabel;
}

export function aggregateSpecsIntoGroups(
  slotEntries: readonly UISlotEntry[],
  locale: string,
  options?: { warn?: (message: string) => void },
): PluginPanelTabGroup[] {
  const groupMap = new Map<string, WritablePluginPanelTabGroup>();
  let counter = 0;

  for (const entry of slotEntries) {
    for (const spec of entry.specs) {
      const specId = spec.id ?? `${entry.pluginId}-${counter++}`;
      const groupKey = spec.group ?? `${entry.pluginId}::${specId}`;

      const subShort = resolveI18n(spec.shortLabel, locale) || undefined;
      const sub: PluginPanelSubPanel = {
        id: specId,
        pluginId: entry.pluginId,
        label: resolveI18n(spec.label, locale),
        shortLabel: subShort,
        icon: spec.icon ?? "layout",
        spec: spec as unknown as Record<string, unknown>,
      };

      const existing = groupMap.get(groupKey);
      if (existing) {
        const incomingLabel = resolveI18n(spec.groupLabel, locale);
        if (incomingLabel && incomingLabel !== existing.label) {
          options?.warn?.(
            `[right-panel] plugin "${entry.pluginId}" declares group "${groupKey}" with label "${incomingLabel}", but group already exists with label "${existing.label}". Keeping first.`,
          );
        }
        existing.subPanels.push(sub);
      } else {
        groupMap.set(groupKey, {
          id: groupKey,
          label: resolveI18n(spec.groupLabel, locale) || sub.label,
          shortLabel: subShort,
          icon: sub.icon,
          order: spec.groupOrder ?? 500,
          subPanels: [sub],
        });
      }
    }
  }

  return Array.from(groupMap.values()).sort((a, b) => a.order - b.order);
}

export function planPluginPanelProviders(
  group: Pick<PluginPanelTabGroup, "subPanels">,
  activeSubIndex: number,
): PluginPanelProviderPlan {
  const byProvider = new Map<string, MutablePluginPanelProviderGroup>();
  group.subPanels.forEach((sub, idx) => {
    if (!byProvider.has(sub.pluginId)) {
      byProvider.set(sub.pluginId, {
        pluginId: sub.pluginId,
        subs: [],
      });
    }
    byProvider.get(sub.pluginId)!.subs.push({ sub, idx });
  });

  const providers = [...byProvider.values()];
  const multiProvider = providers.length > 1;
  const currentSub = group.subPanels[activeSubIndex];
  const activeProviderId = currentSub?.pluginId ?? providers[0]?.pluginId;
  const activeProviderSubs = activeProviderId
    ? (byProvider.get(activeProviderId)?.subs ?? [])
    : [];

  return {
    providers,
    multiProvider,
    ...(activeProviderId ? { activeProviderId } : {}),
    activeProviderSubs,
  };
}

export function panelProviderLabel(
  pluginId: string,
  groupId: string,
  subPanels: readonly PluginPanelSubPanel[],
  sessionPlugins: readonly {
    readonly id: string;
    readonly displayName: unknown;
  }[],
  locale: string,
): string {
  if (groupId === "chat-mode" && subPanels.length > 0) {
    const first = subPanels[0]!;
    return first.shortLabel ?? first.label;
  }
  return pluginShortLabel(pluginId, sessionPlugins, locale);
}

interface WritablePluginPanelTabGroup {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon: string;
  readonly order: number;
  readonly subPanels: PluginPanelSubPanel[];
}

interface MutablePluginPanelProviderGroup {
  readonly pluginId: string;
  readonly subs: {
    readonly sub: PluginPanelSubPanel;
    readonly idx: number;
  }[];
}
