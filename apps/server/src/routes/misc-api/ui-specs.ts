import { loadPluginUiSpecs, pluginDeclarations } from "@covel/plugin-loader";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, SessionRecord } from "@covel/store";
import { runnablePluginIds } from "../api/session/plugins.js";
import { type UiSlotName } from "./shared.js";
import type { UiSpecDiagnostic } from "./ui-spec-schema.js";

const UI_SLOTS = ["right", "message"] as const satisfies readonly UiSlotName[];

type SlotSpecs = Partial<
  Record<UiSlotName, readonly Readonly<Record<string, unknown>>[]>
>;

interface RuntimeSlotSpecs {
  readonly runtimeName: string;
  readonly slots: SlotSpecs;
}

interface PluginSlotSpecs {
  readonly pluginId: string;
  readonly runtimes: readonly RuntimeSlotSpecs[];
}

interface ValidatedSpecs {
  readonly pluginSpecs: readonly PluginSlotSpecs[];
  readonly diagnostics: readonly UiSpecDiagnostic[];
}

// UI declarations belong to the registry snapshot. JSON assets are loaded at
// most once for that snapshot; GET requests never rediscover or reparse plugin
// manifests and never use plugin_data as a hidden materialisation cache.
let specCache = new WeakMap<PluginRegistry, Promise<ValidatedSpecs>>();
const subscribedRegistries = new WeakSet<PluginRegistry>();

/** Test-only: make the next read rebuild the immutable registry projection. */
export function __resetUiSpecsCache(): void {
  specCache = new WeakMap<PluginRegistry, Promise<ValidatedSpecs>>();
}

async function projectRegistryUiSpecs(
  registry: PluginRegistry,
): Promise<ValidatedSpecs> {
  const pluginSpecs: PluginSlotSpecs[] = [];
  const diagnostics: UiSpecDiagnostic[] = [];

  for (const entry of registry.getAll().values()) {
    if (entry.status === "error" || !entry.rootPath) continue;
    const runtimes: RuntimeSlotSpecs[] = [];

    for (const { manifest } of pluginDeclarations(entry)) {
      if (!manifest.ui) continue;
      // The loader checks each spec with the rules `pnpm validate:plugin`
      // uses. A spec it cannot show is reported; the others still render.
      const loaded = await loadPluginUiSpecs(
        entry.rootPath,
        entry.id,
        manifest.ui,
      );
      for (const diagnostic of loaded.diagnostics) {
        console.warn(
          `[ui-specs] ${entry.id}: contributes.ui.${diagnostic.slot}: ${diagnostic.declaredPath} is not shown: ${diagnostic.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")}`,
        );
        diagnostics.push({
          pluginId: entry.id,
          runtimeId: manifest.name,
          slot: diagnostic.slot,
          specIndex: diagnostic.specIndex,
          ...(diagnostic.specId ? { specId: diagnostic.specId } : {}),
          issues: diagnostic.issues.map((issue) => ({
            ...issue,
            code: "invalid",
          })),
        });
      }
      const slots: SlotSpecs = {};
      for (const slot of UI_SLOTS) {
        const specs = loaded.slots[slot];
        if (specs?.length) slots[slot] = specs;
      }
      if (Object.keys(slots).length > 0) {
        runtimes.push({ runtimeName: manifest.name, slots });
      }
    }

    if (runtimes.length > 0) {
      pluginSpecs.push({ pluginId: entry.id, runtimes });
    }
  }

  return { pluginSpecs, diagnostics };
}

async function loadValidatedSpecs(
  registry: PluginRegistry,
): Promise<ValidatedSpecs> {
  const cached = specCache.get(registry);
  if (cached) return cached;
  if (!subscribedRegistries.has(registry)) {
    registry.onChange((event) => {
      if (event.type === "plugin-registered") specCache.delete(registry);
    });
    subscribedRegistries.add(registry);
  }
  const value = projectRegistryUiSpecs(registry);
  specCache.set(registry, value);
  return value;
}

export async function buildUiSpecsResponse(params: {
  sessionId?: string;
  session?: SessionRecord;
  registry: PluginRegistry;
  store: DataStore;
}): Promise<{
  right: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
  message: Array<{
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  }>;
  diagnostics: UiSpecDiagnostic[];
}> {
  const { sessionId, session: knownSession, registry, store } = params;
  const session =
    knownSession ?? (sessionId ? await store.getSession(sessionId) : undefined);
  const activeFilter = session
    ? new Set(runnablePluginIds(session.activePlugins ?? [], registry))
    : undefined;
  const loaded = await loadValidatedSpecs(registry);

  type SlotEntry = {
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  };
  const right: SlotEntry[] = [];
  const message: SlotEntry[] = [];

  for (const plugin of loaded.pluginSpecs) {
    if (activeFilter && !activeFilter.has(plugin.pluginId)) continue;
    for (const slot of UI_SLOTS) {
      const specs = plugin.runtimes.flatMap(
        (runtime) => runtime.slots[slot] ?? [],
      );
      if (specs.length === 0) continue;
      const target = slot === "right" ? right : message;
      target.push({ pluginId: plugin.pluginId, specs });
    }
  }

  const diagnostics = loaded.diagnostics.filter(
    (diagnostic) => !activeFilter || activeFilter.has(diagnostic.pluginId),
  );
  return { right, message, diagnostics };
}
