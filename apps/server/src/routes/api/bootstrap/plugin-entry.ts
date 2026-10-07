import { enforcePluginRegistrationContract } from "@covel/runtime";
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
import { AsyncLocalStorage } from "node:async_hooks";
import {
  replacePluginWires,
  withWireRegistrySnapshot,
} from "@covel/ai-provider";
import { readRuntimeEnv } from "@covel/shared";
import { preparePluginReload } from "./plugin-reload.js";
import type { RuntimeLoader } from "./runtime-loader.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPluginTrustInfo,
  loadPluginEntryDefinition,
  pluginDeclarations,
  loadPluginDefinition,
  type PluginEntryDefinition,
  type ParsedRuntimeMd,
  type PluginDiscoveryResult,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  PluginEntryScope,
  createExtensionRegistration,
  type HookPipeline,
  type PluginRpcRegistry,
} from "@covel/runtime";
import type { DataStore } from "@covel/store";
import type { ToolRegistry } from "@covel/tools";
import { buildEntryApi } from "./plugin-entry-api.js";
import { PluginRegistrationError } from "./plugin-registration-error.js";
import {
  readSessionPluginSelection,
  resolveSessionPluginPlan,
} from "../session/plugins.js";

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
  readonly sessionLock?: import("../../../lib/session-lock.js").SessionLock;
  readonly runtimeLoader?: RuntimeLoader;
  readonly development?: boolean;
  readonly onReload?: (pluginId: string) => void | Promise<void>;
  readonly prepareDeclarations?: (entry: PluginRegistryEntry) => Promise<void>;
  readonly discoveryMap: Map<string, PluginDiscoveryResult>;
  /** Startup quarantine locations used only for static recovery and watching. */
  readonly failedDiscoveryMap?: Map<string, PluginDiscoveryResult>;
  readonly manifestCache: Map<string, readonly ParsedRuntimeMd[]>;
  /** Expose activation failures through the existing plugin discovery DTO. */
  readonly pluginRegistry?: PluginRegistry;
  readonly store: DataStore;
  readonly tools: ToolRegistry;
  readonly hookPipeline: HookPipeline;
  readonly rpcRegistry: PluginRpcRegistry;
  readonly services?: import("@covel/runtime").PluginServiceRegistry;
  readonly extensions?: import("@covel/runtime").PluginExtensionHost;
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
  /** Separate upper bounds for entry initialization and failed-entry cleanup. */
  readonly entryActivationTimeoutMs?: number;
  /** Passive admission skips a failed entry for this long; explicit activation always retries. */
  readonly entryRetryDelayMs?: number;
}

const DEFAULT_ENTRY_ACTIVATION_TIMEOUT_MS = 15_000;
const DEFAULT_ENTRY_RETRY_DELAY_MS = 30_000;

export interface BootstrapPluginEntries {
  withSnapshot<T>(
    sessionId: string,
    fn: () => Promise<T>,
    beforeCapture?: () => Promise<void>,
  ): Promise<T>;
  reload(
    pluginId: string,
    sessionId?: string,
  ): Promise<{ pluginId: string; generation: string }>;
  watch(): void;
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
  /** Current published generation only; reading this never activates code. */
  readonly isEntryPublished: (pluginId: string) => boolean;
  /** True while a recently failed entry should not be re-run by passive discovery. */
  readonly isEntryRetryDeferred: (pluginId: string) => boolean;
}

export async function createBootstrapPluginEntries(
  params: BootstrapPluginEntriesParams,
): Promise<BootstrapPluginEntries> {
  const { discoveryMap, manifestCache, isCommunityServerCodeApproved } = params;
  const entryDefinitions = new Map<string, PluginEntryDefinition>();
  const scopes = new Set<PluginEntryScope>();
  const activeScopes = new Map<string, PluginEntryScope>();
  const snapshotSessions = new AsyncLocalStorage<string>();
  const approvalSessions = new Map<string, Set<string>>();
  const watchers: fsSync.FSWatcher[] = [];
  const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const draining = new Set<Promise<void>>();
  const development =
    params.development ?? readRuntimeEnv().nodeEnv === "development";
  const activationTimeoutMs =
    params.entryActivationTimeoutMs ?? DEFAULT_ENTRY_ACTIVATION_TIMEOUT_MS;
  const retryDelayMs = params.entryRetryDelayMs ?? DEFAULT_ENTRY_RETRY_DELAY_MS;
  const failedAt = new Map<string, number>();
  let publishedRevision = 0;
  let artifactRevision = 0;
  const sessionRevisions = new Map<string, number>();
  let operationTail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(fn);
    operationTail = result.catch(() => {});
    return result;
  };
  // Preparation is serialized per plugin, never with another session's capture.
  const pluginOperations = new Map<string, Promise<unknown>>();
  const serializePlugin = <T>(pluginId: string, fn: () => Promise<T>) => {
    const result = (pluginOperations.get(pluginId) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    pluginOperations.set(pluginId, result);
    void result
      .finally(() => {
        if (pluginOperations.get(pluginId) === result)
          pluginOperations.delete(pluginId);
      })
      .catch(() => {});
    return result;
  };
  const failedDisposals = new Map<PluginEntryScope, Promise<void>>();
  const disposeFailedEntry = (batch: PluginEntryScope, reason: unknown) => {
    const previous = failedDisposals.get(batch);
    if (previous) return previous;
    // dispose synchronously closes registration and unpublishes. An uncooperative
    // cleanup must not prevent failure reporting, retry, or host shutdown.
    const disposal = batch.dispose(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([
      disposal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("plugin entry cleanup timed out")),
          activationTimeoutMs,
        );
        timer.unref?.();
      }),
    ])
      .then(() => {
        scopes.delete(batch);
        failedDisposals.delete(batch);
      })
      .finally(() => clearTimeout(timer));
    failedDisposals.set(batch, bounded);
    return bounded;
  };
  const admissions = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const reportActivation = (
    pluginId: string,
    error?: string,
    cause?: unknown,
  ): void => {
    const entry = params.pluginRegistry?.get(pluginId);
    if (!entry) return;
    const {
      error: _previousError,
      registrationError: _previousRegistrationError,
      ...definition
    } = entry;
    params.pluginRegistry!.register({
      ...definition,
      // Valid declarations remain available to command/UI discovery so the
      // next invocation can retry activation. Only discovery rejects a package.
      ...(error ? { error } : {}),
      ...(cause instanceof PluginRegistrationError
        ? {
            registrationError: {
              code: cause.code,
              registration: cause.registration,
            },
          }
        : {}),
    });
  };

  // Compile entry declarations once. Both the approval/pending path and actual
  // activation consume this exact definition, so metadata-only multi-runtime
  // roots cannot be visible to one path and absent from the other.
  for (const [pluginId, discovery] of discoveryMap) {
    const registryEntry = params.pluginRegistry?.get(pluginId);
    try {
      const definition = await loadPluginEntryDefinition(
        discovery,
        registryEntry
          ? pluginDeclarations(registryEntry)
          : pluginDeclarations(await loadPluginDefinition(discovery)),
      );
      entryDefinitions.set(pluginId, definition);
    } catch (error) {
      // Discovery read the same files. One that changed since then costs this
      // package its entry, never the other packages or the server's start.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[bootstrap] Failed to prepare the entry of plugin ${pluginId}:`,
        message,
      );
      reportActivation(pluginId, message, error);
    }
  }

  const prepareEntry = async (
    pluginId: string,
    definition: PluginEntryDefinition,
    generation?: string,
  ): Promise<PluginEntryScope> => {
    const batch = new PluginEntryScope();
    scopes.add(batch);
    const registration = createExtensionRegistration(
      params.extensions,
      pluginId,
      definition.extensions,
      batch,
      (message) => new PluginRegistrationError("provideExtension", message),
      definition.staticPromptSegments,
      definition.staticPromptVariants,
    );
    const checked = enforcePluginRegistrationContract(
      buildEntryApi(params, pluginId, batch, registration.provideExtension),
      definition.contributions,
      (message) => new PluginRegistrationError("declarations", message),
    );
    const api = checked.api;
    let currentEntry = "";
    try {
      const factories = (async () => {
        for (const entryPath of definition.entryPaths) {
          batch.signal.throwIfAborted();
          currentEntry = entryPath;
          const fullPath = path.resolve(definition.pluginRoot, entryPath);
          await assertInsideRoot(definition.pluginRoot, fullPath);
          batch.signal.throwIfAborted();
          if (!fsSync.existsSync(fullPath)) {
            throw new Error(`entry file not found: ${entryPath}`);
          }
          const url = pathToFileURL(fullPath);
          if (generation) url.searchParams.set("generation", generation);
          const mod = await import(url.href);
          batch.signal.throwIfAborted();
          const factory: unknown = mod.default;
          if (typeof factory !== "function") {
            throw new Error(
              "entry must default-export a function (covel) => { ... }",
            );
          }
          await factory(api);
        }
      })();
      // A factory that outlives the budget sees a closed, aborted scope.
      void factories.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          factories,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const timeout = new PluginRegistrationError(
                "activation-timeout",
                `entry activation exceeded ${activationTimeoutMs}ms`,
              );
              batch.abort(timeout);
              reject(timeout);
            }, activationTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (closed) throw new Error("plugin entries are closed");
      checked.validate();
      registration.validate();
      return batch;
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
        await disposeFailedEntry(batch, error);
      } catch (rollbackError) {
        throw new AggregateError([failure, rollbackError], failure.message);
      } finally {
        // Failed cleanup stays owned so host shutdown also reports it.
        reportActivation(pluginId, diagnostic, error);
      }
      throw failure;
    }
  };

  const invokeEntryForPlugin = async (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    try {
      await publishEntryForPlugin(pluginId, sessionId);
      failedAt.delete(pluginId);
    } catch (error) {
      failedAt.set(pluginId, Date.now());
      throw error;
    }
  };

  const publishEntryForPlugin = async (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    const definition = entryDefinitions.get(pluginId);
    if (!definition) return;
    const batch = await prepareEntry(pluginId, definition);
    try {
      await serialize(async () => {
        if (closed) throw new Error("plugin entries are closed");
        if (
          !getPluginTrustInfo(pluginId, discoveryMap.get(pluginId)?.source)
            .autoLoad &&
          !(await isCommunityServerCodeApproved?.(sessionId, pluginId))
        )
          throw new Error(
            "Plugin entry approval was revoked before publication",
          );
        if (closed) throw new Error("plugin entries are closed");
        try {
          batch.commit();
          activeScopes.set(pluginId, batch);
          reportActivation(pluginId);
          artifactRevision += 1;
        } catch (error) {
          // Remove partial registrations before another capture can run.
          void disposeFailedEntry(batch, error).catch(() => {});
          throw error;
        }
      });
    } catch (error) {
      const diagnostic =
        error instanceof PluginRegistrationError
          ? `[${error.code}] ${error.message}`
          : "Entry activation failed; check the server log for details.";
      const failure = new Error(
        `[plugin-entry] ${pluginId}: failed to activate entry: ${diagnostic}`,
        { cause: error },
      );
      try {
        await disposeFailedEntry(batch, error);
      } catch (rollbackError) {
        throw new AggregateError([failure, rollbackError], failure.message);
      } finally {
        reportActivation(pluginId, diagnostic, error);
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
    if (sessionId) {
      const sessions = approvalSessions.get(pluginId) ?? new Set<string>();
      sessions.add(sessionId);
      approvalSessions.set(pluginId, sessions);
    }
    if (invokedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;
    const result = serializePlugin(pluginId, async () => {
      try {
        if (closed) throw new Error("plugin entries are closed");
        if (
          !trust.autoLoad &&
          !(await isCommunityServerCodeApproved?.(sessionId, pluginId))
        )
          throw new Error(
            "Plugin entry approval was revoked before activation",
          );
        if (closed) throw new Error("plugin entries are closed");
        // A reload can publish while this first activation is queued.
        if (!invokedPluginIds.has(pluginId)) {
          await invokeEntryForPlugin(pluginId, sessionId);
          invokedPluginIds.add(pluginId);
        }
      } finally {
        inFlight.delete(pluginId);
      }
    });
    inFlight.set(pluginId, result);
    return result;
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

  const reload: BootstrapPluginEntries["reload"] = (
    pluginId,
    requestedSessionId,
  ) =>
    serializePlugin(pluginId, async () => {
      if (closed) throw new Error("plugin entries are closed");
      if (!development)
        throw new Error("Plugin reload is available only in development mode");
      const quarantined =
        !discoveryMap.has(pluginId) && params.failedDiscoveryMap?.has(pluginId);
      const discovery =
        discoveryMap.get(pluginId) ?? params.failedDiscoveryMap?.get(pluginId);
      if (!discovery) throw new Error("Plugin not found");
      if (getPluginTrustInfo(pluginId, discovery.source).autoLoad)
        throw new Error("Bundled plugins cannot be hot reloaded");
      const candidates = requestedSessionId
        ? [requestedSessionId]
        : [...(approvalSessions.get(pluginId) ?? [])];
      let approvedSession: string | undefined;
      for (const candidate of candidates)
        if (await isCommunityServerCodeApproved?.(candidate, pluginId)) {
          approvedSession = candidate;
          break;
        }
      if (!approvedSession && !quarantined)
        throw new Error("Plugin reload requires a live server-code approval");
      const next = await preparePluginReload(discovery, [
        ...(params.pluginRegistry?.getAll().values() ?? []),
      ]);
      await params.prepareDeclarations?.(next.entry);
      const generation = crypto.randomUUID();
      if (!approvedSession) {
        // Only startup quarantine may recover without executing server code.
        // Static loading validates identity, schemas and declarations; entry,
        // handler and guard imports remain behind the normal approval gate.
        await serialize(async () => {
          if (closed) throw new Error("plugin entries are closed");
          if (
            discoveryMap.has(pluginId) ||
            activeScopes.has(pluginId) ||
            invokedPluginIds.has(pluginId)
          )
            throw new Error("Static recovery requires a quarantined plugin");
          params.pluginRegistry?.register(next.entry);
          discoveryMap.set(pluginId, next.discovery);
          manifestCache.set(pluginId, next.definition.manifests);
          entryDefinitions.set(pluginId, next.entryDefinition);
          params.failedDiscoveryMap?.delete(pluginId);
          artifactRevision += 1;
          publishedRevision += 1;
        });
        try {
          await params.onReload?.(pluginId);
        } catch (error) {
          console.warn("[plugin-entry] reload observer failed", {
            pluginId,
            error,
          });
        }
        return { pluginId, generation };
      }
      const batch = await prepareEntry(
        pluginId,
        next.entryDefinition,
        generation,
      );
      const previousEntry = params.pluginRegistry?.get(pluginId);
      const previousScope = activeScopes.get(pluginId);
      try {
        const publishRuntimeGeneration =
          await params.runtimeLoader?.prepareGeneration({
            discovery: next.discovery,
            definition: next.definition,
            generation,
            sessionIds: [
              approvedSession,
              ...(approvalSessions.get(pluginId) ?? []),
            ],
          });
        await serialize(async () => {
          if (
            closed ||
            !(await isCommunityServerCodeApproved?.(approvedSession, pluginId))
          )
            throw new Error("Plugin reload approval was revoked");
          if (closed) throw new Error("plugin entries are closed");
          try {
            params.tools.replacePlugin(pluginId, () =>
              params.hookPipeline.replacePlugin(pluginId, () =>
                params.rpcRegistry.replacePlugin(pluginId, () =>
                  replacePluginWires(pluginId, () => {
                    const publish = () => {
                      batch.commit();
                      params.pluginRegistry?.register(next.entry);
                    };
                    if (params.services)
                      params.services.replacePlugin(pluginId, publish);
                    else publish();
                  }),
                ),
              ),
            );
            discoveryMap.set(pluginId, next.discovery);
            params.failedDiscoveryMap?.delete(pluginId);
            manifestCache.set(pluginId, next.definition.manifests);
            entryDefinitions.set(pluginId, next.entryDefinition);
            publishRuntimeGeneration?.();
            activeScopes.set(pluginId, batch);
            invokedPluginIds.add(pluginId);
            const sessions =
              approvalSessions.get(pluginId) ?? new Set<string>();
            sessions.add(approvedSession);
            approvalSessions.set(pluginId, sessions);
            failedAt.delete(pluginId);
            publishedRevision += 1;
            artifactRevision += 1;
          } catch (error) {
            if (previousEntry) params.pluginRegistry?.register(previousEntry);
            void disposeFailedEntry(batch, error).catch(() => {});
            throw error;
          }
        });
      } catch (error) {
        await disposeFailedEntry(batch, error);
        throw error;
      }
      if (previousScope) {
        const completion = previousScope.drain();
        draining.add(completion);
        void completion.then(
          () => {
            scopes.delete(previousScope);
            draining.delete(completion);
          },
          (error) => {
            draining.delete(completion);
            console.warn("[plugin-entry] draining cleanup failed", {
              pluginId,
              error,
            });
          },
        );
      }
      try {
        await params.onReload?.(pluginId);
      } catch (error) {
        console.warn("[plugin-entry] reload observer failed", {
          pluginId,
          error,
        });
      }
      return { pluginId, generation };
    });

  return {
    reload,
    async withSnapshot(sessionId, fn, beforeCapture) {
      if (snapshotSessions.getStore() === sessionId) {
        if (beforeCapture) {
          if (params.sessionLock)
            await params.sessionLock.withLock(sessionId, beforeCapture);
          else await beforeCapture();
        }
        return fn();
      }
      const capture = async () => {
        await beforeCapture?.();
        for (;;) {
          const revision = await serialize(async () => {
            if (closed) throw new Error("plugin entries are closed");
            // Resolve against the same publication as the captured artifacts. A
            // reload can change requirements or single-provider conflicts without
            // any plugin-toggle request. Callers hold the session admission lock.
            if (
              params.pluginRegistry &&
              (sessionRevisions.get(sessionId) ?? 0) < publishedRevision
            ) {
              const session = await params.store.getSession(sessionId);
              if (!session)
                throw new Error("Session not found during plugin admission");
              const authorized: string[] = [];
              for (const entry of params.pluginRegistry.getAll().values()) {
                if (
                  getPluginTrustInfo(entry.id, entry.source).autoLoad ||
                  (await isCommunityServerCodeApproved?.(sessionId, entry.id))
                )
                  authorized.push(entry.id);
              }
              const selection = readSessionPluginSelection(session);
              const plan = resolveSessionPluginPlan(
                selection.requested,
                params.pluginRegistry,
                {
                  excluded: selection.excluded,
                  requiredContracts: selection.requiredContracts,
                  authorized,
                },
              );
              if (
                JSON.stringify(plan.active) !==
                JSON.stringify(session.activePlugins)
              )
                await params.store.updateSession(sessionId, {
                  activePlugins: plan.active,
                });
              params.pluginRegistry.syncSessionActivations(
                sessionId,
                plan.active,
              );
              sessionRevisions.set(sessionId, publishedRevision);
            }
            return artifactRevision;
          });
          // Runtime loading may activate entries. Keep it outside publication,
          // then retry only if a generation actually changed while loading.
          let runtime:
            Awaited<ReturnType<RuntimeLoader["capture"]>> | undefined;
          try {
            runtime = await params.runtimeLoader?.capture(sessionId);
          } catch (error) {
            // A concurrent publication can invalidate a manifest mid-load.
            if (!closed && revision !== artifactRevision) continue;
            throw error;
          }
          const captured = await serialize(async () => {
            if (closed) throw new Error("plugin entries are closed");
            if (revision !== artifactRevision) return undefined;
            // Include every admitted entry: services can cross active plugin boundaries.
            const releases: (() => void)[] = [];
            try {
              for (const scope of activeScopes.values())
                releases.push(scope.retain());
            } catch (error) {
              for (const release of releases.reverse()) release();
              throw error;
            }
            const run = <T>(task: () => T): T =>
              params.tools.withSnapshot(() =>
                params.hookPipeline.withSnapshot(() =>
                  params.rpcRegistry.withSnapshot(() =>
                    withWireRegistrySnapshot(() => {
                      const inside = () =>
                        params.pluginRegistry
                          ? params.pluginRegistry.withSnapshot(task)
                          : task();
                      return params.services
                        ? params.services.withSnapshot(inside)
                        : inside();
                    }),
                  ),
                ),
              );
            // Capture ALS maps before releasing the publication queue, then retain the
            // continuation closure. The task itself must execute outside that queue.
            let execute!: <T>(task: () => T) => T;
            run(() => {
              execute = AsyncLocalStorage.snapshot();
            });
            return {
              run: <T>(task: () => T) =>
                execute(() => (runtime ? runtime.run(task) : task())),
              releases,
            };
          });
          if (captured) return captured;
        }
      };
      const captured = params.sessionLock
        ? await params.sessionLock.withLock(sessionId, capture)
        : await capture();
      try {
        return await captured.run(() => snapshotSessions.run(sessionId, fn));
      } finally {
        for (const release of captured.releases.reverse()) release();
      }
    },
    watch() {
      if (!development || closed || watchers.length) return;
      const watchable = new Map([
        ...(params.failedDiscoveryMap ?? []),
        ...discoveryMap,
      ]);
      for (const [pluginId, discovery] of watchable) {
        if (getPluginTrustInfo(pluginId, discovery.source).autoLoad) continue;
        let watcher: fsSync.FSWatcher;
        try {
          watcher = fsSync.watch(
            discovery.rootPath,
            { recursive: true, persistent: false },
            (_event, filename) => {
              if (
                !filename ||
                /(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(String(filename))
              )
                return;
              const existing = watchTimers.get(pluginId);
              if (existing) clearTimeout(existing);
              const timer = setTimeout(() => {
                watchTimers.delete(pluginId);
                void reload(pluginId).catch((error) =>
                  console.warn("[plugin-entry] watched reload failed", {
                    pluginId,
                    error,
                  }),
                );
              }, 150);
              timer.unref?.();
              watchTimers.set(pluginId, timer);
            },
          );
        } catch (error) {
          console.warn("[plugin-entry] watcher failed", { pluginId, error });
          continue;
        }
        watcher.on("error", (error) =>
          console.warn("[plugin-entry] watcher failed", { pluginId, error }),
        );
        watchers.push(watcher);
      }
    },
    ensurePluginEntry,
    hasPendingEntry,
    isEntryPublished: (pluginId) => !closed && activeScopes.has(pluginId),
    isEntryRetryDeferred: (pluginId) => {
      const failed = failedAt.get(pluginId);
      return (
        failed !== undefined &&
        !invokedPluginIds.has(pluginId) &&
        Date.now() - failed < retryDelayMs
      );
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const watcher of watchers.splice(0)) watcher.close();
      for (const timer of watchTimers.values()) clearTimeout(timer);
      watchTimers.clear();
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled(admissions);
        await Promise.allSettled(pluginOperations.values());
        await operationTail;
        await Promise.allSettled(draining);
        const errors: unknown[] = [];
        for (const batch of [...scopes].reverse()) {
          try {
            await (failedDisposals.get(batch) ?? batch.dispose());
          } catch (error) {
            errors.push(error);
          } finally {
            scopes.delete(batch);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "plugin entry cleanup failed");
      });
      // Publish closing before synchronous abort listeners can re-enter close.
      for (const scope of scopes) scope.abort();
      return closing;
    },
  };
}
