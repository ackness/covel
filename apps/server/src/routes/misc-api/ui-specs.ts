import type {
  ResolvedPluginTheme,
  ResolvedPluginThemeEntry,
  SlashCommandSpec,
} from "@covel/shared";
import {
  ID_BEARING_UI_SLOTS,
  loadPluginUiSpecs,
  PLUGIN_UI_SPEC_SLOTS,
  pluginDeclarations,
} from "@covel/plugin-loader";
import type { PluginAssetRoot, PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, SessionRecord } from "@covel/store";
import { isInstancePluginAllowed } from "../api/bootstrap/instance-plugins.js";
import { mergePluginCommands } from "../api/session/commands.js";
import { runnablePluginIds } from "../api/session/plugins.js";
import type { PermissionService } from "../../trust/permission-service.js";
import type { TrustedSourceService } from "../../trust/trusted-source-service.js";
import { type UiSlotName } from "./shared.js";
import type { UiSpecDiagnostic } from "./ui-spec-schema.js";

const UI_SLOTS = PLUGIN_UI_SPEC_SLOTS satisfies readonly UiSlotName[];
const SESSION_UI_SLOTS = [
  "right",
  "message",
  "view",
  "segment",
  "composerAction",
  "messageAction",
  "messageBelow",
] as const;
const INSTANCE_UI_SLOTS = [
  "settingsSection",
  "appPage",
  "topbarStatus",
] as const;
const INSTANCE_SLOT_SET = new Set<string>(INSTANCE_UI_SLOTS);

export interface AppCommandProjection extends SlashCommandSpec {
  readonly id: string;
  readonly pluginId: string;
  readonly source: "plugin";
  readonly sourceLabel: string | Readonly<Record<string, string>>;
}

type SlotSpecs = Partial<
  Record<
    Exclude<UiSlotName, "theme">,
    readonly Readonly<Record<string, unknown>>[]
  >
>;

interface RuntimeSlotSpecs {
  readonly runtimeName: string;
  readonly slots: SlotSpecs;
}

interface PluginSlotSpecs {
  readonly themes: readonly ResolvedPluginTheme[];
  readonly pluginId: string;
  readonly runtimes: readonly RuntimeSlotSpecs[];
  readonly appCommands: readonly AppCommandProjection[];
}

interface ValidatedSpecs {
  readonly assets: ReadonlyMap<string, ReadonlyMap<string, PluginAssetRoot>>;
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
  const assets = new Map<string, Map<string, PluginAssetRoot>>();
  const diagnostics: UiSpecDiagnostic[] = [];

  for (const entry of registry.getAll().values()) {
    if (entry.status === "error" || !entry.rootPath) continue;
    const runtimes: RuntimeSlotSpecs[] = [];
    const seenIdsBySlot = new Map<UiSlotName, Set<string>>();
    const themes: ResolvedPluginTheme[] = [];
    const themeState = { ids: new Set<string>(), count: 0 };
    const appCommands: AppCommandProjection[] = mergePluginCommands(entry)
      .filter((cmd) => cmd.scope === "instance")
      .map((cmd) => ({
        ...cmd,
        id: `${entry.id}:${cmd.name}`,
        pluginId: entry.id,
        source: "plugin" as const,
        sourceLabel: entry.summary.displayName ?? entry.summary.name,
      }));

    for (const { manifest } of pluginDeclarations(entry)) {
      if (!manifest.ui) continue;
      // The loader checks each spec with the rules `pnpm validate:plugin`
      // uses. A spec it cannot show is reported; the others still render.
      const loaded = await loadPluginUiSpecs(
        entry.rootPath,
        entry.id,
        manifest.ui,
        themeState,
      );
      themes.push(...loaded.themes);
      for (const asset of loaded.assets) {
        const roots =
          assets.get(entry.id) ?? new Map<string, PluginAssetRoot>();
        roots.set(asset.digest, asset);
        assets.set(entry.id, roots);
      }
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
          declaredPath: diagnostic.declaredPath,
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
        if (!specs?.length) continue;
        if (!ID_BEARING_UI_SLOTS.has(slot)) {
          slots[slot] = specs;
          continue;
        }
        slots[slot] = specs.filter((spec, specIndex) => {
          const id = spec.id as string;
          let seen = seenIdsBySlot.get(slot);
          if (!seen) {
            seen = new Set<string>();
            seenIdsBySlot.set(slot, seen);
          }
          if (!seen.has(id)) {
            seen.add(id);
            return true;
          }
          diagnostics.push({
            pluginId: entry.id,
            runtimeId: manifest.name,
            slot,
            specIndex,
            specId: id,
            issues: [
              {
                path: "id",
                code: "invalid",
                message: `duplicate ${slot} id "${id}"`,
              },
            ],
          });
          return false;
        });
      }
      if (Object.keys(slots).length > 0) {
        runtimes.push({ runtimeName: manifest.name, slots });
      }
    }

    if (runtimes.length > 0 || themes.length > 0 || appCommands.length > 0) {
      pluginSpecs.push({ pluginId: entry.id, runtimes, themes, appCommands });
    }
  }

  return { pluginSpecs, diagnostics, assets };
}

function loadValidatedSpecs(registry: PluginRegistry): Promise<ValidatedSpecs> {
  const cached = specCache.get(registry);
  if (cached) return cached;
  if (!subscribedRegistries.has(registry)) {
    registry.onChange((event) => {
      if (event.type === "plugin-registered") specCache.delete(registry);
    });
    subscribedRegistries.add(registry);
  }
  const pending: Promise<ValidatedSpecs> = projectRegistryUiSpecs(
    registry,
  ).catch((error: unknown) => {
    if (specCache.get(registry) === pending) specCache.delete(registry);
    throw error;
  });
  specCache.set(registry, pending);
  return pending;
}

export interface UiSpecsSlotGroup {
  readonly pluginId: string;
  readonly specs: readonly Record<string, unknown>[];
}

export async function buildUiSpecsResponse(params: {
  sessionId?: string;
  session?: SessionRecord;
  registry: PluginRegistry;
  store: DataStore;
  permissionService?: PermissionService;
  trustedSources?: TrustedSourceService;
}): Promise<{
  right: UiSpecsSlotGroup[];
  message: UiSpecsSlotGroup[];
  view: UiSpecsSlotGroup[];
  /**
   * Story paragraph templates, in the session's plugin order when a session
   * is given; the client breaks ties in this order.
   */
  segment: UiSpecsSlotGroup[];
  settingsSection: UiSpecsSlotGroup[];
  appPage: UiSpecsSlotGroup[];
  topbarStatus: UiSpecsSlotGroup[];
  composerAction: UiSpecsSlotGroup[];
  messageAction: UiSpecsSlotGroup[];
  messageBelow: UiSpecsSlotGroup[];
  window: UiSpecsSlotGroup[];
  appCommands: AppCommandProjection[];
  theme: ResolvedPluginThemeEntry[];
  diagnostics: UiSpecDiagnostic[];
}> {
  const {
    sessionId,
    session: knownSession,
    registry,
    store,
    permissionService,
    trustedSources,
  } = params;
  const session =
    knownSession ?? (sessionId ? await store.getSession(sessionId) : undefined);
  const runnable = session
    ? runnablePluginIds(session.activePlugins ?? [], registry)
    : undefined;
  const activeFilter = runnable ? new Set(runnable) : undefined;
  const loaded = await loadValidatedSpecs(registry);

  const instanceAllowed = (pluginId: string): boolean =>
    isInstancePluginAllowed(
      { registry, permissionService, trustedSources },
      pluginId,
    );

  const bySlot: Record<Exclude<UiSlotName, "theme">, UiSpecsSlotGroup[]> = {
    right: [],
    message: [],
    view: [],
    segment: [],
    settingsSection: [],
    appPage: [],
    topbarStatus: [],
    composerAction: [],
    messageAction: [],
    messageBelow: [],
    window: [],
  };

  const theme: ResolvedPluginThemeEntry[] = [];
  const appCommands: AppCommandProjection[] = [];
  for (const plugin of loaded.pluginSpecs) {
    const sessionAllowed = !activeFilter || activeFilter.has(plugin.pluginId);
    const canShowInstance = instanceAllowed(plugin.pluginId);
    if (sessionAllowed && plugin.themes.length) {
      theme.push({
        pluginId: plugin.pluginId,
        specs: plugin.themes.map((spec) => structuredClone(spec)),
      });
    }
    if (sessionAllowed) {
      for (const slot of SESSION_UI_SLOTS) {
        const specs = plugin.runtimes.flatMap(
          (runtime) => runtime.slots[slot] ?? [],
        );
        if (specs.length > 0) {
          bySlot[slot].push({ pluginId: plugin.pluginId, specs });
        }
      }
    }
    if (canShowInstance) {
      for (const slot of INSTANCE_UI_SLOTS) {
        const specs = plugin.runtimes.flatMap(
          (runtime) => runtime.slots[slot] ?? [],
        );
        if (specs.length > 0) {
          bySlot[slot].push({ pluginId: plugin.pluginId, specs });
        }
      }
      if (plugin.appCommands.length > 0) {
        appCommands.push(...plugin.appCommands);
      }
    }
    const windowSpecs = plugin.runtimes
      .flatMap((runtime) => runtime.slots.window ?? [])
      .filter((spec) =>
        spec.windowScope === "instance" ? canShowInstance : sessionAllowed,
      );
    if (windowSpecs.length > 0) {
      bySlot.window.push({ pluginId: plugin.pluginId, specs: windowSpecs });
    }
  }

  // Equally specific templates go to the earlier plugin, so segment entries
  // follow the session's plugin order, not the registry's.
  if (runnable) {
    const position = new Map(runnable.map((id, index) => [id, index]));
    bySlot.segment.sort(
      (a, b) => position.get(a.pluginId)! - position.get(b.pluginId)!,
    );
  }

  const diagnostics = loaded.diagnostics.filter(
    (diagnostic) =>
      !activeFilter ||
      activeFilter.has(diagnostic.pluginId) ||
      (INSTANCE_SLOT_SET.has(diagnostic.slot) &&
        instanceAllowed(diagnostic.pluginId)),
  );
  return { ...bySlot, appCommands, theme, diagnostics };
}

export async function findPluginAssetRoot(
  registry: PluginRegistry,
  pluginId: string,
  digest: string,
): Promise<PluginAssetRoot | undefined> {
  return (await loadValidatedSpecs(registry)).assets.get(pluginId)?.get(digest);
}
