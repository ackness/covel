/**
 * Plugin media-wire loading — the server half of the `wires` PLUGIN.md
 * frontmatter field.
 *
 * A wires module lets a plugin register vendor image / speech /
 * transcription wires into @covel/ai-provider's registries, so its (and
 * other plugins') `ctx.images` / `ctx.speech` calls can route to that
 * vendor via llm.toml `providerRequestMetadata.{image,speech,transcription}Wire`.
 * Registered ids are namespaced `"<pluginId>/<wireId>"` to prevent
 * collisions with builtin wires and other plugins.
 *
 * Trust gating mirrors local-tools.ts: builtin/official plugins load at
 * bootstrap; community plugins load on `ensurePluginWires()` — called from
 * `loadRuntimeFn`, i.e. the same moment the framework would import the
 * plugin's handler.js anyway, so no new trust exposure.
 */

import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPluginTrustInfo,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  fetchWithRetry,
  registerImageWire,
  registerSpeechWire,
  registerTranscriptionWire,
  validateBaseUrlForPlugin,
  type ImageWire,
  type SpeechWire,
  type TranscriptionWire,
} from "@covel/ai-provider";

export interface BootstrapPluginWiresParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
}

export interface BootstrapPluginWires {
  /** Deferred load — memoized per pluginId, safe to await on every loadRuntime. */
  readonly ensurePluginWires: (pluginId: string) => Promise<void>;
}

export interface WireModuleShape {
  readonly image?: readonly ImageWire[];
  readonly speech?: readonly SpeechWire[];
  readonly transcription?: readonly TranscriptionWire[];
}

/** Injected into factory-form wires modules so community plugins get the
 *  framework's SSRF guard + retrying fetch without importing @covel/ai-provider. */
const wireInjection = {
  fetchWithRetry,
  validateBaseUrl: validateBaseUrlForPlugin,
};

function hasWireShape(value: unknown, method: string): value is { id: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    (value as Record<string, unknown>).id !== "" &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}

/**
 * Register a wire module's wires under the `<pluginId>/<wireId>` namespace.
 * Shared by the legacy `wires` frontmatter loader below and the unified
 * `entry` registration path (plugin-entry.ts).
 */
export function registerNamespaced(
  pluginId: string,
  pluginRelPath: string,
  mod: WireModuleShape,
): void {
  const groups: ReadonlyArray<{
    readonly wires: readonly { id: string }[] | undefined;
    readonly method: string;
    readonly register: (wire: never) => void;
  }> = [
    { wires: mod.image, method: "generate", register: registerImageWire },
    { wires: mod.speech, method: "synthesize", register: registerSpeechWire },
    {
      wires: mod.transcription,
      method: "transcribe",
      register: registerTranscriptionWire,
    },
  ];

  for (const group of groups) {
    for (const wire of group.wires ?? []) {
      if (!hasWireShape(wire, group.method)) {
        console.warn(
          `[plugin-wires] ${pluginRelPath}: skipping malformed wire entry — expected { id: string, ${group.method}: fn }`,
        );
        continue;
      }
      const namespaced = { ...wire, id: `${pluginId}/${wire.id}` };
      try {
        group.register(namespaced as never);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already registered/.test(message)) {
          // Idempotency: double bootstrap (dev restarts, test harnesses)
          // re-imports the same module — same id, same plugin, skip quietly.
          console.warn(
            `[plugin-wires] ${pluginRelPath}: wire "${namespaced.id}" already registered — skipping`,
          );
          continue;
        }
        throw err;
      }
    }
  }
}

export async function createBootstrapPluginWires({
  discoveryMap,
  manifestCache,
}: BootstrapPluginWiresParams): Promise<BootstrapPluginWires> {
  const loadWiresForPlugin = async (pluginId: string): Promise<void> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return;

    // Multiple runtimes may (incorrectly) declare the same wires module —
    // dedupe by resolved path so it registers once.
    const wirePaths = new Set<string>();
    for (const parsed of manifests) {
      if (parsed.manifest.wires) wirePaths.add(parsed.manifest.wires);
    }

    const pluginRelPath = path.relative(
      process.cwd(),
      path.join(discovery.rootPath, "PLUGIN.md"),
    );
    for (const wiresPath of wirePaths) {
      const fullPath = path.resolve(discovery.rootPath, wiresPath);
      try {
        const rel = path.relative(discovery.rootPath, fullPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          console.warn(
            `[plugin-wires] ${pluginRelPath}: wires "${wiresPath}" escapes the plugin root\n` +
              `Fix: Use a path relative to the plugin directory (no "../" traversal).`,
          );
          continue;
        }
        if (!fsSync.existsSync(fullPath)) {
          console.warn(
            `[plugin-wires] ${pluginRelPath}: wires file not found — ${fullPath}\n` +
              `Fix: Create the file, or remove the wires entry from PLUGIN.md.`,
          );
          continue;
        }
        const mod = await import(pathToFileURL(fullPath).href);
        const exported = mod.default ?? Object.values(mod)[0];
        const shape: unknown =
          typeof exported === "function" ? exported(wireInjection) : exported;
        if (!shape || typeof shape !== "object") {
          console.warn(
            `[plugin-wires] ${pluginRelPath}: wires module must default-export { image?, speech?, transcription? } or a factory returning it`,
          );
          continue;
        }
        registerNamespaced(pluginId, pluginRelPath, shape as WireModuleShape);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[plugin-wires] ${pluginRelPath}: failed to load wires "${wiresPath}" — ${message}`,
        );
      }
    }
  };

  // builtin/official: register at bootstrap so their wires are available to
  // every plugin's slots from the first turn.
  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    await loadWiresForPlugin(pluginId);
  }

  const loadedPluginIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  const ensurePluginWires = async (pluginId: string): Promise<void> => {
    if (loadedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;

    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (trust.autoLoad) {
      // Already handled in the bootstrap loop above.
      loadedPluginIds.add(pluginId);
      return;
    }

    const promise = (async () => {
      try {
        await loadWiresForPlugin(pluginId);
        loadedPluginIds.add(pluginId);
      } finally {
        inFlight.delete(pluginId);
      }
    })();
    inFlight.set(pluginId, promise);
    return promise;
  };

  return { ensurePluginWires };
}
