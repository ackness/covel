/**
 * Unified plugin server entry — the `entry` PLUGIN.md frontmatter field.
 *
 * An entry module default-exports a factory `function (covel: PluginAPI)`
 * (sync or async) that registers the plugin's server-side capabilities
 * imperatively through one facade:
 *
 *   export default function (covel) {
 *     covel.registerTool(covel.toolkit.tool({ ... }));
 *     covel.on("PostLLMResponse", handler);
 *     covel.registerRpc("my-action", handler);
 *     covel.registerWires({ image: [myWire] });
 *   }
 *
 * Trust gating mirrors runtime handlers: builtin entries run at bootstrap;
 * community entries run on `ensurePluginEntry()` (memoized and
 * in-flight-deduped) after the server-code approval gate clears.
 */

import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPluginTrustInfo,
  loadPluginEntryDefinition,
  type PluginEntryDefinition,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { type HookPipeline, type PluginRpcRegistry } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import type { ToolModule } from "@covel/tools";
import { buildEntryApi } from "./plugin-entry-api.js";
import { EntryRegistrationBatch } from "./entry-registration-batch.js";
import { PluginRegistrationError } from "./plugin-registration-error.js";

/**
 * Validate that `target` is inside `root` after resolving symlinks.
 * Mirrors `assertInsideRoot` in @covel/plugin-loader (load.ts): fs.realpath
 * defeats symlink-based path traversal; falls back to a lexical check when
 * the target does not exist on disk.
 */
async function assertInsideRoot(root: string, target: string): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fsSync.promises.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  try {
    realTarget = await fsSync.promises.realpath(target);
  } catch {
    // Target doesn't exist — fall back to lexical check (a non-existent path
    // cannot be imported anyway).
    realTarget = path.resolve(target);
  }
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("entry path escapes the plugin root");
  }
}

// `PluginAPI` / `PluginToolkit` (and the related option types) are the
// Public Plugin API — they live in @covel/runtime so plugin authors can
// import them. `buildEntryApi` is annotated `: PluginAPI`, so this
// implementation cannot drift from the published contract without a
// compile error.

export interface BootstrapPluginEntriesParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  /** Expose activation failures through the existing plugin discovery DTO. */
  readonly pluginRegistry?: PluginRegistry;
  readonly store: DataStore;
  readonly toolMap: Map<string, ToolModule>;
  readonly localToolNames: Set<string>;
  /** Mutable: entry-registered tool names are discovered at invocation time. */
  readonly pluginToolAccess: Map<string, Set<string>>;
  readonly hookPipeline: HookPipeline;
  readonly rpcRegistry: PluginRpcRegistry;
  readonly services?: import("@covel/runtime").PluginServiceRegistry;
  /** Fail-closed session authorization for community server code. */
  readonly isCommunityServerCodeApproved?: (
    sessionId: string | undefined,
    pluginId: string,
  ) => boolean | Promise<boolean>;
  /** Narrower grant used for lifecycle hook execution after import. */
  readonly isCommunityHookApproved?: (
    sessionId: string,
    pluginId: string,
  ) => boolean | Promise<boolean>;
}

export interface BootstrapPluginEntries {
  /** Stop activation, await in-flight factories/approval checks, then unregister owned capabilities. */
  close(): Promise<void>;
  /** Deferred entry invocation — memoized per pluginId, safe to await repeatedly. */
  readonly ensurePluginEntry: (
    pluginId: string,
    sessionId?: string,
  ) => Promise<void>;
  /**
   * True when `pluginId` declares an `entry` and activation has not yet
   * succeeded (deferred community entry or failed builtin entry). The plugin-rpc
   * action-level path uses this to route an unregistered action through the
   * approval gate instead of a hard 404 — the action's registration lives
   * inside the not-yet-run entry.
   */
  readonly hasPendingEntry: (pluginId: string) => boolean;
}

export async function createBootstrapPluginEntries(
  params: BootstrapPluginEntriesParams,
): Promise<BootstrapPluginEntries> {
  const { discoveryMap, manifestCache, isCommunityServerCodeApproved } = params;
  const entryDefinitions = new Map<string, PluginEntryDefinition>();
  const registrations: EntryRegistrationBatch[] = [];
  const admissions = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const reportActivation = (pluginId: string, error?: string): void => {
    const entry = params.pluginRegistry?.get(pluginId);
    if (!entry) return;
    const { error: _previousError, ...definition } = entry;
    params.pluginRegistry!.register({
      ...definition,
      // Valid declarations remain available to command/UI discovery so the
      // next invocation can retry activation. Only discovery rejects a package.
      ...(error ? { error } : {}),
    });
  };

  // Compile entry declarations once. Both the approval/pending path and actual
  // activation consume this exact definition, so metadata-only multi-runtime
  // roots cannot be visible to one path and absent from the other.
  for (const [pluginId, discovery] of discoveryMap) {
    const definition = await loadPluginEntryDefinition(
      discovery,
      manifestCache.get(pluginId) ?? [],
    );
    entryDefinitions.set(pluginId, definition);
    if (definition.rootManifestIssue) {
      console.warn(
        `[plugin-entry] ${path.relative(process.cwd(), definition.rootManifestIssue.path)}: failed to parse root PLUGIN.md for entry —`,
        definition.rootManifestIssue.message,
      );
    }
  }

  const invokeEntryForPlugin = async (pluginId: string): Promise<void> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const definition = entryDefinitions.get(pluginId);
    if (!definition || definition.entryPaths.length === 0) return;

    const batch = new EntryRegistrationBatch();
    const api = buildEntryApi(params, pluginId, batch);
    let currentEntry = "";
    try {
      for (const entryPath of definition.entryPaths) {
        currentEntry = entryPath;
        const fullPath = path.resolve(definition.pluginRoot, entryPath);
        await assertInsideRoot(definition.pluginRoot, fullPath);
        if (!fsSync.existsSync(fullPath)) {
          throw new Error(`entry file not found: ${entryPath}`);
        }
        const mod = await import(pathToFileURL(fullPath).href);
        const factory: unknown = mod.default;
        if (typeof factory !== "function") {
          throw new Error(
            "entry must default-export a function (covel) => { ... }",
          );
        }
        await factory(api);
      }
      if (closed) throw new Error("plugin entries are closed");
      batch.commit();
      registrations.push(batch);
      reportActivation(pluginId);
    } catch (error) {
      const diagnostic =
        error instanceof PluginRegistrationError
          ? `[${error.code}] ${error.message}`
          : "Entry activation failed; check the server log for details.";
      const failure = new Error(
        `[plugin-entry] ${pluginId}: failed to activate entry "${currentEntry}": ${diagnostic}`,
        { cause: error },
      );
      try {
        batch.rollback();
      } catch (rollbackError) {
        throw new AggregateError([failure, rollbackError], failure.message);
      } finally {
        reportActivation(pluginId, diagnostic);
      }
      throw failure;
    }
  };

  const invokedPluginIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  // Builtin entries run at bootstrap so their capabilities are
  // available from the first turn.
  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    try {
      await invokeEntryForPlugin(pluginId);
      invokedPluginIds.add(pluginId);
    } catch (error) {
      console.warn(error);
    }
  }

  // Community entry hooks exist only after the entry is approved and invoked;
  // lifecycle events emitted before activation are intentionally not replayed.
  const activate = async (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (
      !trust.autoLoad &&
      !(await isCommunityServerCodeApproved?.(sessionId, pluginId))
    ) {
      throw new Error(
        `[plugin-entry] ${pluginId}: community server code requires explicit approval for session ${sessionId ?? "<missing>"}`,
      );
    }
    if (closed) throw new Error("plugin entries are closed");
    if (invokedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;

    const promise = (async () => {
      try {
        await invokeEntryForPlugin(pluginId);
        invokedPluginIds.add(pluginId);
      } finally {
        inFlight.delete(pluginId);
      }
    })();
    inFlight.set(pluginId, promise);
    return promise;
  };

  const ensurePluginEntry = (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    if (closed) return Promise.reject(new Error("plugin entries are closed"));
    const admission = activate(pluginId, sessionId);
    admissions.add(admission);
    void admission.then(
      () => admissions.delete(admission),
      () => admissions.delete(admission),
    );
    return admission;
  };

  const hasPendingEntry = (pluginId: string): boolean => {
    if (invokedPluginIds.has(pluginId)) return false;
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return false;
    // Failed builtin activations remain retryable, just like deferred entries.
    return (entryDefinitions.get(pluginId)?.entryPaths.length ?? 0) > 0;
  };

  return {
    ensurePluginEntry,
    hasPendingEntry,
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled(admissions);
        const errors: unknown[] = [];
        for (const batch of registrations.splice(0).reverse()) {
          try {
            batch.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "plugin entry cleanup failed");
      });
      return closing;
    },
  };
}
