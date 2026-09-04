import fs from "node:fs/promises";
import path from "node:path";
import type {
  LoadedRuntime,
  PluginRegistry,
  PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { DataStore, SessionRecord } from "@covel/store";
import type { RuntimeManifest } from "@covel/shared";
import {
  pluginManifestRecords,
  pluginRuntimeDirectory,
} from "./registry-projection.js";
import { type UiSlotName } from "./shared.js";
import { partitionSlotSpecs, type UiSpecDiagnostic } from "./ui-spec-schema.js";

const UI_SLOTS = [
  "right",
  "message",
  "left",
] as const satisfies readonly UiSlotName[];

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

function assertInsidePluginRoot(pluginRoot: string, filePath: string): void {
  const relative = path.relative(pluginRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`UI spec path escapes plugin root: ${filePath}`);
  }
}

async function loadSlot(
  pluginRoot: string,
  runtimeDirectory: string,
  paths: readonly string[] | undefined,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  if (!paths || paths.length === 0) return undefined;
  const specs: Readonly<Record<string, unknown>>[] = [];
  for (const declaredPath of paths) {
    const filePath = path.resolve(runtimeDirectory, declaredPath);
    assertInsidePluginRoot(pluginRoot, filePath);
    if (filePath.endsWith(".json")) {
      specs.push(
        JSON.parse(await fs.readFile(filePath, "utf-8")) as Readonly<
          Record<string, unknown>
        >,
      );
    } else {
      specs.push({ _componentPath: declaredPath });
    }
  }
  return specs;
}

async function loadDeclaredUiSpecs(
  entry: PluginRegistryEntry,
  runtimeName: string,
  ui: NonNullable<RuntimeManifest["ui"]>,
): Promise<LoadedRuntime["uiSpecs"]> {
  const runtimeDirectory = pluginRuntimeDirectory(entry, runtimeName);
  if (!entry.rootPath || !runtimeDirectory) return undefined;
  const [right, message, left] = await Promise.all([
    loadSlot(entry.rootPath, runtimeDirectory, ui.right),
    loadSlot(entry.rootPath, runtimeDirectory, ui.message),
    loadSlot(entry.rootPath, runtimeDirectory, ui.left),
  ]);
  if (!right && !message && !left) return undefined;
  return { right, message, left };
}

async function projectRegistryUiSpecs(
  registry: PluginRegistry,
): Promise<ValidatedSpecs> {
  const pluginSpecs: PluginSlotSpecs[] = [];
  const diagnostics: UiSpecDiagnostic[] = [];

  for (const entry of registry.getAll().values()) {
    if (entry.status === "error") continue;
    const runtimes: RuntimeSlotSpecs[] = [];

    for (const { manifest } of pluginManifestRecords(entry)) {
      if (!manifest.ui) continue;
      const loaded = entry.loadedRuntimes.get(manifest.name);
      const uiSpecs =
        loaded?.uiSpecs ??
        (await loadDeclaredUiSpecs(entry, manifest.name, manifest.ui).catch(
          (error: unknown) => {
            console.error(
              `[ui-specs] Failed to load static UI specs for "${entry.id}/${manifest.name}":`,
              error,
            );
            return undefined;
          },
        ));
      if (!uiSpecs) continue;

      const slots: SlotSpecs = {};
      for (const slot of UI_SLOTS) {
        const specs = uiSpecs[slot];
        if (!specs || specs.length === 0) continue;
        const partition = partitionSlotSpecs({
          specs: specs as readonly Record<string, unknown>[],
          pluginId: entry.id,
          runtimeId: manifest.name,
          slot,
        });
        diagnostics.push(...partition.diagnostics);
        if (partition.valid.length > 0) slots[slot] = partition.valid;
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
    registry.onChange(() => specCache.delete(registry));
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
  left: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
  diagnostics: UiSpecDiagnostic[];
}> {
  const { sessionId, session: knownSession, registry, store } = params;
  const session =
    knownSession ?? (sessionId ? await store.getSession(sessionId) : undefined);
  const activeFilter = session
    ? new Set(session.activePlugins ?? [])
    : undefined;
  const loaded = await loadValidatedSpecs(registry);

  type SlotEntry = {
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  };
  const right: SlotEntry[] = [];
  const message: SlotEntry[] = [];
  const left: SlotEntry[] = [];

  for (const plugin of loaded.pluginSpecs) {
    if (activeFilter && !activeFilter.has(plugin.pluginId)) continue;
    for (const slot of UI_SLOTS) {
      const specs = plugin.runtimes.flatMap(
        (runtime) => runtime.slots[slot] ?? [],
      );
      if (specs.length === 0) continue;
      const target =
        slot === "right" ? right : slot === "message" ? message : left;
      target.push({ pluginId: plugin.pluginId, specs });
    }
  }

  const diagnostics = loaded.diagnostics.filter(
    (diagnostic) => !activeFilter || activeFilter.has(diagnostic.pluginId),
  );
  return { right, message, left, diagnostics };
}
