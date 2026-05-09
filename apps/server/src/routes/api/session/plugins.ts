import {
  getPluginTrustInfo,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";

const CHAT_MODE_PLUGIN_IDS = [
  "chat-mode-narrator",
  "scene-cast",
  "scene-prompts",
  "character-blueprint",
  "character-presence",
  "player-identity",
  "living-world-rules",
  "branch-reply",
] as const;

export function isRequiredCorePlugin(entry: PluginRegistryEntry): boolean {
  const trust = getPluginTrustInfo(entry.id, entry.source);
  return (
    entry.summary.pluginType === "core-plugin" && trust.source === "builtin"
  );
}

function requiredCorePluginIds(pluginRegistry: PluginRegistry): string[] {
  return [...pluginRegistry.getAll().values()]
    .filter(isRequiredCorePlugin)
    .map((entry) => entry.id);
}

export function unknownPluginIds(
  requestedPlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string[] {
  return requestedPlugins.filter((pid) => !pluginRegistry.get(pid));
}

export function resolveSessionPlugins(
  requestedPlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string[] {
  const requested = new Set(requestedPlugins);
  const corePlugins = requiredCorePluginIds(pluginRegistry);
  const active = new Set([...requestedPlugins, ...corePlugins]);

  if (
    requested.has("chat-mode-narrator") &&
    pluginRegistry.get("chat-mode-narrator")
  ) {
    for (const pluginId of CHAT_MODE_PLUGIN_IDS) {
      if (pluginRegistry.get(pluginId)) {
        active.add(pluginId);
      }
    }
    active.delete("narrator");
  }

  return [...active];
}

export function resolveEnabledSessionPlugins(
  currentPlugins: readonly string[],
  pluginId: string,
  pluginRegistry: PluginRegistry,
): string[] {
  return resolveSessionPlugins([...currentPlugins, pluginId], pluginRegistry);
}

export function buildAvailablePluginList(
  active: readonly string[],
  pluginRegistry: PluginRegistry,
): Array<Record<string, unknown>> {
  const all = pluginRegistry.getAll();
  return Array.from(all.values()).map((entry) => {
    // Aggregated capabilities (plugin-level + runtime-level union) keep the
    // existing UI surface working: gates only need "does this plugin do X".
    const caps: string[] = [];
    const tags: string[] = [];
    if (entry.manifest?.manifest.capabilities) {
      caps.push(...entry.manifest.manifest.capabilities);
    }
    for (const tag of entry.summary.tags ?? []) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    const runtimes: Array<{
      id: string;
      runtimeType?: string;
      model?: string;
      outputKind?: string;
      trigger?: { type: string; topic?: string };
      capabilities?: string[];
      tags?: string[];
      relations?: unknown;
    }> = [];
    for (const [, loaded] of entry.loadedRuntimes) {
      const m = loaded.manifest;
      if (m.capabilities) {
        for (const c of m.capabilities) {
          if (!caps.includes(c)) caps.push(c);
        }
      }
      for (const tag of m.tags ?? []) {
        if (!tags.includes(tag)) tags.push(tag);
      }
      runtimes.push({
        id: m.name,
        ...(m.runtimeType ? { runtimeType: m.runtimeType } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.outputKind ? { outputKind: m.outputKind } : {}),
        ...(m.trigger
          ? {
              trigger: {
                type: m.trigger.type,
                ...(m.trigger.topic ? { topic: m.trigger.topic } : {}),
              },
            }
          : {}),
        ...(m.capabilities && m.capabilities.length > 0
          ? { capabilities: [...m.capabilities] }
          : {}),
        ...(m.tags && m.tags.length > 0 ? { tags: [...m.tags] } : {}),
        ...(m.relations ? { relations: m.relations } : {}),
      });
    }

    const trust = getPluginTrustInfo(entry.id, entry.source);
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      source: trust.source,
      active: active.includes(entry.id),
      ...(caps.length > 0 ? { capabilities: caps } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(entry.summary.relations
        ? { relations: entry.summary.relations }
        : {}),
      ...(runtimes.length > 0 ? { runtimes } : {}),
    };
  });
}

export function buildSnapshotPluginList(
  pluginRegistry: PluginRegistry,
  activeIds: ReadonlySet<string>,
): Array<{
  id: string;
  name: string;
  isActive: boolean;
  priority: number;
}> {
  const pluginList: Array<{
    id: string;
    name: string;
    isActive: boolean;
    priority: number;
  }> = [];
  for (const [, entry] of pluginRegistry.getAll()) {
    const manifests =
      entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
    const primary = manifests[0]?.manifest;
    pluginList.push({
      id: entry.id,
      name:
        typeof entry.summary.name === "string" ? entry.summary.name : entry.id,
      isActive: activeIds.has(entry.id),
      priority: primary?.priority ?? 500,
    });
  }
  return pluginList;
}

export function findWorldDataProviderPluginId(
  activePlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string | undefined {
  for (const pid of activePlugins) {
    const entry = pluginRegistry.get(pid);
    if (!entry) continue;
    if (
      entry.manifest?.manifest.capabilities?.includes("world-data-provider")
    ) {
      return pid;
    }
    for (const [, loaded] of entry.loadedRuntimes) {
      if (loaded.manifest.capabilities?.includes("world-data-provider")) {
        return pid;
      }
    }
  }
  return undefined;
}
