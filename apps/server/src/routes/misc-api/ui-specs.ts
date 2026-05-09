import {
  discoverPluginsMulti,
  loadPluginManifest,
  loadRuntime,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import {
  resolvePluginsDirs,
  UI_NAMESPACE_BY_SLOT,
  type UiSlotName,
} from "./shared.js";

async function syncUiSpecsToStore(
  sessionId: string,
  activePluginIds: ReadonlySet<string>,
  store: DataStore,
): Promise<void> {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
  const now = new Date().toISOString();
  const writes: Array<{
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }> = [];

  for (const discovery of discoveries) {
    if (!activePluginIds.has(discovery.id)) continue;

    const manifests = await loadPluginManifest(discovery);

    // Clear old cached specs for this plugin so hot-reloads don't leave stale blocks behind.
    for (const namespace of Object.values(UI_NAMESPACE_BY_SLOT)) {
      const existing = await store.listPluginData(
        sessionId,
        discovery.id,
        namespace,
      );
      for (const row of existing) {
        await store.deletePluginData(
          sessionId,
          discovery.id,
          namespace,
          row.key,
        );
      }
    }

    for (const [runtimeIndex, parsed] of manifests.entries()) {
      const loaded = await loadRuntime(discovery, parsed.manifest.name);
      if (!loaded.uiSpecs) continue;

      for (const slot of Object.keys(UI_NAMESPACE_BY_SLOT) as UiSlotName[]) {
        const specs = loaded.uiSpecs[slot];
        if (!specs || specs.length === 0) continue;
        writes.push({
          id: crypto.randomUUID(),
          sessionId,
          pluginId: discovery.id,
          namespace: UI_NAMESPACE_BY_SLOT[slot],
          key: `${String(runtimeIndex).padStart(3, "0")}:${loaded.manifest.name}`,
          value: specs,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (writes.length > 0) {
    await store.setPluginDataBatch(writes);
  }
}

export async function buildUiSpecsResponse(params: {
  sessionId?: string;
  registry: PluginRegistry;
  store: DataStore;
}): Promise<{
  right: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
  message: Array<{
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  }>;
  left: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
}> {
  const { sessionId, registry, store } = params;
  type SlotEntry = {
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  };
  const right: SlotEntry[] = [];
  const message: SlotEntry[] = [];
  const left: SlotEntry[] = [];

  let activeFilter: Set<string> | null = null;
  if (sessionId) {
    const session = await store.getSession(sessionId);
    if (session) {
      activeFilter = new Set(session.activePlugins ?? []);
      await syncUiSpecsToStore(sessionId, activeFilter, store);
    }
  }

  if (sessionId && activeFilter) {
    for (const pluginId of activeFilter) {
      const [rightRows, messageRows, leftRows] = await Promise.all([
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.right),
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.message),
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.left),
      ]);

      const toSpecs = (rows: typeof rightRows) =>
        rows
          .sort((a, b) => a.key.localeCompare(b.key))
          .flatMap((row) =>
            Array.isArray(row.value)
              ? (row.value as Record<string, unknown>[])
              : [],
          );

      const rightSpecs = toSpecs(rightRows);
      const messageSpecs = toSpecs(messageRows);
      const leftSpecs = toSpecs(leftRows);

      if (rightSpecs.length) right.push({ pluginId, specs: rightSpecs });
      if (messageSpecs.length) message.push({ pluginId, specs: messageSpecs });
      if (leftSpecs.length) left.push({ pluginId, specs: leftSpecs });
    }
  } else {
    const all = registry.getAll();
    for (const [, entry] of all) {
      if (entry.status === "error") continue;
      if (activeFilter && !activeFilter.has(entry.id)) continue;

      for (const [, loaded] of entry.loadedRuntimes) {
        if (!loaded.uiSpecs) continue;
        const pluginId = loaded.manifest.pluginId;

        if (loaded.uiSpecs.right?.length) {
          right.push({ pluginId, specs: loaded.uiSpecs.right });
        }
        if (loaded.uiSpecs.message?.length) {
          message.push({ pluginId, specs: loaded.uiSpecs.message });
        }
        if (loaded.uiSpecs.left?.length) {
          left.push({ pluginId, specs: loaded.uiSpecs.left });
        }
      }
    }
  }

  return { right, message, left };
}
