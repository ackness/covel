import { validateRuntimeManifestSemantics } from "@covel/shared";
import type { EventBus } from "@covel/events";
import {
  createPluginRegistry,
  discoverPluginsMulti,
  loadPluginManifest,
  loadPluginSummary,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
  type PluginRegistry,
} from "@covel/plugin-loader";

export interface DiscoverAndRegisterPluginsConfig {
  readonly pluginsDir: string;
  readonly pluginsDirs?: readonly string[];
  readonly eventBus: EventBus;
}

export interface DiscoverAndRegisterPluginsResult {
  readonly registry: PluginRegistry;
  readonly discoveryMap: Map<string, PluginDiscoveryResult>;
  readonly manifestCache: Map<string, readonly ParsedPluginMd[]>;
}

export async function discoverAndRegisterPlugins(
  config: DiscoverAndRegisterPluginsConfig,
): Promise<DiscoverAndRegisterPluginsResult> {
  const registry = createPluginRegistry({ eventBus: config.eventBus });
  const pluginsDirs =
    config.pluginsDirs && config.pluginsDirs.length > 0
      ? config.pluginsDirs
      : [config.pluginsDir];
  const discoveries = await discoverPluginsMulti(
    pluginsDirs,
    (id, kept, skipped) => {
      console.warn(
        `[bootstrap] Plugin id collision: "${id}" — keeping ${kept}, ignoring ${skipped}`,
      );
    },
  );

  const discoveryMap = new Map<string, PluginDiscoveryResult>();
  const manifestCache = new Map<string, readonly ParsedPluginMd[]>();

  for (const discovery of discoveries) {
    try {
      const summary = await loadPluginSummary(discovery);
      const manifests = await loadPluginManifest(discovery);

      for (const parsed of manifests) {
        for (const diagnostic of validateRuntimeManifestSemantics(
          parsed.manifest,
        )) {
          console.warn(`[bootstrap] ${diagnostic.message}`);
        }
        // Tool access and plugin-data are keyed by the directory name
        // (discovery.id), but findTool, the store, proposals, hooks and trust
        // checks all use the frontmatter-derived manifest.pluginId. A
        // mismatch splits the plugin's identity in two — the install path
        // enforces equality (validatePluginBundle), and since the 2026-07-20
        // audit  discovery enforces it too: registering under a forged
        // frontmatter name would let a directory impersonate another plugin's
        // (including a builtin's) store namespace and trust tier. Hard-fail
        // the plugin (it registers as `status: "error"` below) instead of
        // warn-and-continue.
        if (parsed.manifest.pluginId !== discovery.id) {
          throw new Error(
            `plugin identity mismatch: frontmatter name root "${parsed.manifest.pluginId}" ` +
              `does not match the plugin directory name "${discovery.id}" — ` +
              "rename one to match; the plugin was not registered",
          );
        }
      }

      // Publish the discovery caches only after every manifest passed
      // validation: bootstrap's tool/hook/wire/RPC wiring consumes these maps
      // directly, so a plugin that fails identity validation below must leave
      // no capability behind (quarantine, not warn-and-continue).
      discoveryMap.set(discovery.id, discovery);
      manifestCache.set(discovery.id, manifests);

      // Register with all manifests (first is primary for getActiveRuntimes).
      // `source` comes from `discoverPluginsMulti`: bundled first-dir plugins
      // keep their prefix-derived trust, everything else is clamped to
      // `'community'` — so a third-party plugin can't self-assign a higher
      // trust level by forging `pluginType: core-plugin` in its frontmatter.
      registry.register({
        id: discovery.id,
        summary,
        rootPath: discovery.rootPath,
        manifest: manifests[0],
        manifests,
        loadedRuntimes: new Map(),
        status: "registered",
        ...(discovery.source ? { source: discovery.source } : {}),
      });
    } catch (err) {
      // Undo any capability caches published before the failure. registry
      // registration itself can throw (e.g. a dataSchemas conflict) after the
      // sets above ran, so without this a plugin left in `error` status would
      // still be visible to the tool/hook/wire/RPC wiring. delete is a no-op
      // when validation failed before the sets executed.
      discoveryMap.delete(discovery.id);
      manifestCache.delete(discovery.id);

      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[bootstrap] Failed to load plugin ${discovery.id}:`,
        message,
      );

      // Register as error so the frontend can display it without aborting boot.
      registry.register({
        id: discovery.id,
        summary: {
          id: discovery.id,
          name: discovery.id,
          description: "",
          pluginType: "plugin",
          runtimeCount: 0,
        },
        loadedRuntimes: new Map(),
        status: "error",
        error: message,
        ...(discovery.source ? { source: discovery.source } : {}),
      });
    }
  }

  return { registry, discoveryMap, manifestCache };
}
