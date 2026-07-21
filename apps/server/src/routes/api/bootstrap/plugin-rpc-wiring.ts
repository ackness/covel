import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  type PluginRpcRegistry,
  type RpcExecutor,
  type RpcHandler,
} from "@covel/runtime";
import {
  getPluginTrustInfo,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";

export interface CreateBootstrapPluginRpcParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
}

export interface BootstrapPluginRpc {
  readonly rpcRegistry: PluginRpcRegistry;
  readonly rpcExecutor: RpcExecutor;
  readonly rpcApprovalGate: RpcApprovalGate;
}

export function createBootstrapPluginRpc({
  discoveryMap,
  manifestCache,
}: CreateBootstrapPluginRpcParams): BootstrapPluginRpc {
  const rpcRegistry: PluginRpcRegistry = createPluginRpcRegistry();
  rpcRegistry.registerFrameworkDefault("submit-form", submitFormHandler, {
    description:
      "Persist player input submissions and fill the originating template message.",
  });

  for (const [pluginId, manifests] of manifestCache) {
    for (const parsed of manifests) {
      const rpcMap = parsed.manifest.rpc;
      if (!rpcMap) continue;
      const discovery = discoveryMap.get(pluginId);
      const trustInfo = getPluginTrustInfo(pluginId, discovery?.source);
      const trustLevel: "builtin" | "official" | "community" =
        trustInfo.source === "builtin"
          ? "builtin"
          : trustInfo.source === "community"
            ? "community"
            : "official";
      for (const [action, decl] of Object.entries(rpcMap)) {
        try {
          rpcRegistry.registerPluginAction(pluginId, action, decl, trustLevel);
        } catch (err) {
          console.warn(
            `[bootstrap] plugin-rpc registration failed for ${pluginId}::${action}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  const rpcExecutor: RpcExecutor = createRpcExecutor({
    registry: rpcRegistry,
    loadHandler: async (pluginId, handlerPath) => {
      const discovery = discoveryMap.get(pluginId);
      if (!discovery) {
        throw new Error(`plugin "${pluginId}" not found in discovery map`);
      }
      // Defence-in-depth: even though the schema rejects `..` and
      // absolute paths, a future schema change or a hand-crafted manifest
      // could still produce something that escapes the plugin root. Resolve
      // and verify containment before importing.
      const rootPath = path.resolve(discovery.rootPath);
      const absPath = path.resolve(rootPath, handlerPath);
      const rootWithSep = rootPath.endsWith(path.sep)
        ? rootPath
        : rootPath + path.sep;
      if (!absPath.startsWith(rootWithSep) && absPath !== rootPath) {
        throw new Error(
          `handler path "${handlerPath}" escapes plugin root for "${pluginId}"`,
        );
      }
      const mod = (await import(pathToFileURL(absPath).href)) as {
        default?: RpcHandler;
      };
      if (typeof mod.default !== "function") {
        throw new Error(
          `handler at ${handlerPath} has no default export function`,
        );
      }
      return mod.default;
    },
  });

  // Pending approvals + session-cached pre-authorizations live in memory per
  // bootstrap instance; they do not survive a restart or cross processes.
  const rpcApprovalGate: RpcApprovalGate = createRpcApprovalGate();

  return { rpcRegistry, rpcExecutor, rpcApprovalGate };
}
