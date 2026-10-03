/** Approved runtime loading and immutable per-execution artifact generations. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeManifest } from "@covel/shared";
import {
  loadRuntime as loadRuntimeFromDisk,
  resolveRuntimePrompt,
  getPluginTrustInfo,
  type PluginRegistry,
  type ParsedRuntimeMd,
  type PluginDiscoveryResult,
  type LoadedRuntime,
  type PluginDefinition,
} from "@covel/plugin-loader";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { DataStore } from "@covel/store";
import { sessionApprovalScope } from "../session/session-guard.js";

export interface RuntimeLoaderParams {
  readonly pluginRegistry?: PluginRegistry;
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedRuntimeMd[]>;
  readonly store: DataStore;
  readonly getApprovalGate: () => RpcApprovalGate;
}
export interface RuntimeArtifactSnapshot {
  run<T>(fn: () => T): T;
}
export interface RuntimeLoader {
  readonly loadRuntimeFn: (
    manifest: RuntimeManifest,
    locale?: string,
    sessionId?: string,
  ) => Promise<LoadedRuntime | undefined>;
  ensurePluginEntry(pluginId: string, sessionId?: string): Promise<void>;
  bindPluginEntry(
    fn: (pluginId: string, sessionId?: string) => Promise<void>,
  ): void;
  /** The entry manager checks publication consistency after asynchronous loading. */
  capture(sessionId: string): Promise<RuntimeArtifactSnapshot>;
  prepareGeneration(args: {
    discovery: PluginDiscoveryResult;
    definition: PluginDefinition;
    generation: string;
    sessionIds: readonly string[];
  }): Promise<() => void>;
}
export function createRuntimeLoader(
  params: RuntimeLoaderParams,
): RuntimeLoader {
  const { discoveryMap, manifestCache, store, getApprovalGate } = params;
  let boundEnsurePluginEntry: (
    pluginId: string,
    sessionId?: string,
  ) => Promise<void> = async () => {};
  const generations = new Map<string, string>();
  const artifacts = new Map<string, Promise<LoadedRuntime>>();
  const snapshots = new AsyncLocalStorage<{
    sessionId: string;
    locale?: string;
    loaded: ReadonlyMap<string, LoadedRuntime>;
    prompts: ReadonlyMap<string, ParsedRuntimeMd>;
  }>();

  const authorized = async (
    pluginId: string,
    runtimeName: string,
    sessionId?: string,
  ): Promise<boolean> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return false;
    if (getPluginTrustInfo(pluginId, discovery.source).autoLoad) return true;
    const session = sessionId ? await store.getSession(sessionId) : undefined;
    if (!sessionId || !session) return false;
    const scope = sessionApprovalScope(session, pluginId);
    const gate = getApprovalGate();
    return (
      gate.hasGrant(sessionId, pluginId, COMMUNITY_SERVER_CODE_ACTION, scope) &&
      gate.hasGrant(sessionId, pluginId, `runtime:${runtimeName}`, scope)
    );
  };

  const loadRuntimeFn: RuntimeLoader["loadRuntimeFn"] = async (
    manifest,
    locale,
    sessionId,
  ) => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (
        !manifests?.some((m) => m.manifest.name === manifest.name) &&
        !snapshots.getStore()?.loaded.has(manifest.name)
      )
        continue;
      if (manifest.pluginId !== pluginId) continue;
      // Grants remain live: an old artifact snapshot never authorizes revoked code.
      if (!(await authorized(pluginId, manifest.name, sessionId)))
        throw new Error(
          `[runtime-loader] ${pluginId}/${manifest.name}: community runtime requires explicit session approval (server-code AND runtime grants)`,
        );
      const captured = snapshots.getStore();
      if (captured) {
        if (captured.sessionId !== sessionId)
          throw new Error("Runtime snapshot belongs to another session");
        const loaded = captured.loaded.get(manifest.name);
        if (!loaded)
          throw new Error(
            `Runtime ${manifest.name} was not admitted in this execution snapshot`,
          );
        return {
          ...loaded,
          promptTemplate: resolveRuntimePrompt(
            captured.prompts.get(manifest.name)!,
            locale ?? captured.locale,
          ),
        };
      }
      // No runtime module may be imported before entry authorization succeeds.
      await boundEnsurePluginEntry(pluginId, sessionId);
      const entry = params.pluginRegistry?.get(pluginId);
      if (!entry?.packageManifest?.plugin)
        throw new Error(`Missing plugin definition: ${pluginId}`);
      const generation = generations.get(pluginId) ?? "initial";
      const key = JSON.stringify([
        pluginId,
        generation,
        locale ?? "",
        manifest.name,
      ]);
      let pending = artifacts.get(key);
      if (!pending) {
        pending = loadRuntimeFromDisk(
          discovery,
          manifest.name,
          locale,
          {
            packageManifest: entry.packageManifest,
            manifests: manifests ?? [],
          },
          Object.fromEntries(
            [...params.pluginRegistry!.getAll().values()].flatMap((e) =>
              Object.entries(e.packageManifest?.contractSchemas ?? {}),
            ),
          ),
          generation,
        );
        artifacts.set(key, pending);
        void pending.catch(() => {
          if (artifacts.get(key) === pending) artifacts.delete(key);
        });
      }
      return pending;
    }
    return undefined;
  };

  return {
    loadRuntimeFn,
    ensurePluginEntry: (pluginId, sessionId) =>
      boundEnsurePluginEntry(pluginId, sessionId),
    bindPluginEntry(fn) {
      boundEnsurePluginEntry = fn;
    },
    async prepareGeneration({ discovery, definition, generation, sessionIds }) {
      const staged = new Map<string, Promise<LoadedRuntime>>();
      const contracts = Object.fromEntries([
        ...[...(params.pluginRegistry?.getAll().values() ?? [])]
          .filter((entry) => entry.id !== discovery.id)
          .flatMap((entry) =>
            Object.entries(entry.packageManifest?.contractSchemas ?? {}),
          ),
        ...Object.entries(definition.packageManifest?.contractSchemas ?? {}),
      ]);
      for (const sessionId of new Set(sessionIds)) {
        const session = await store.getSession(sessionId);
        if (!session) continue;
        for (const parsed of definition.manifests) {
          if (
            !(await authorized(discovery.id, parsed.manifest.name, sessionId))
          )
            continue;
          const key = JSON.stringify([
            discovery.id,
            generation,
            session.locale ?? "",
            parsed.manifest.name,
          ]);
          if (staged.has(key)) continue;
          const pending = loadRuntimeFromDisk(
            discovery,
            parsed.manifest.name,
            session.locale,
            definition,
            contracts,
            generation,
          );
          staged.set(key, pending);
          await pending;
        }
      }
      return () => {
        generations.set(discovery.id, generation);
        // Existing snapshots own their refs; publish only validated new artifacts.
        for (const key of artifacts.keys())
          if ((JSON.parse(key) as string[])[0] === discovery.id)
            artifacts.delete(key);
        for (const [key, value] of staged) artifacts.set(key, value);
      };
    },
    async capture(sessionId) {
      const existing = snapshots.getStore();
      if (existing) {
        if (existing.sessionId !== sessionId)
          throw new Error("Runtime snapshot belongs to another session");
        return { run: (fn) => fn() };
      }
      const session = await store.getSession(sessionId);
      if (!session)
        throw new Error("Session not found while capturing runtimes");
      const effectiveLocale = session.locale;
      const loaded = new Map<string, LoadedRuntime>();
      const prompts = new Map<string, ParsedRuntimeMd>();
      for (const pluginId of session.activePlugins) {
        for (const parsed of manifestCache.get(pluginId) ?? []) {
          if (!(await authorized(pluginId, parsed.manifest.name, sessionId)))
            continue;
          const runtime = await loadRuntimeFn(
            parsed.manifest,
            effectiveLocale,
            sessionId,
          );
          if (runtime) {
            loaded.set(parsed.manifest.name, runtime);
            prompts.set(parsed.manifest.name, parsed);
          }
        }
      }
      return {
        run: (fn) =>
          snapshots.run(
            { sessionId, locale: effectiveLocale, loaded, prompts },
            fn,
          ),
      };
    },
  };
}
