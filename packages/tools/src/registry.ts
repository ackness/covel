/**
 * Tool registry — registers, looks up, and manages tools.
 */

import type { RuntimeManifest } from "@covel/shared";
import { InMemoryToolClient } from "./in-memory-client.js";
import type { ToolClient, ToolClientEntry } from "./client.js";
import type { ResolvedTool } from "./types.js";

export interface ToolRegistry {
  /** Register a resolved tool. */
  register(tool: ResolvedTool, client?: ToolClient): void;

  /** Register a client and index the tools it exposes. */
  registerClient(client: ToolClient, tools: readonly ResolvedTool[]): void;

  /** Look up by full name (covel_xxx_xxx_xxx). */
  getByFullName(fullName: string): ResolvedTool | undefined;

  /** Look up a tool and the client that owns execution. */
  getClientEntry(fullName: string): ToolClientEntry | undefined;

  /** Resolve the client that owns a tool. */
  getClientForTool(fullName: string): ToolClient | undefined;

  /** Get all tools available to a specific runtime. */
  getToolsForRuntime(
    pluginId: string,
    runtimeId: string,
    manifest: RuntimeManifest,
  ): readonly ResolvedTool[];

  /** Unregister all tools for a plugin. */
  unregisterPlugin(pluginId: string): void;

  /** Get count of registered tools. */
  readonly size: number;
}

/**
 * Generate the full tool name: covel_{plugin}_{runtime}_{fn}
 * Converts hyphens to underscores.
 */
export function generateToolName(
  pluginId: string,
  runtimeId: string,
  localName: string,
): string {
  const normalize = (s: string): string => s.replace(/-/g, "_");
  return `covel_${normalize(pluginId)}_${normalize(runtimeId)}_${normalize(localName)}`;
}

/**
 * Create an in-memory tool registry.
 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ResolvedTool>();
  const clients = new Map<string, ToolClient>();
  const clientByTool = new Map<string, ToolClient>();
  const builtinClient = new InMemoryToolClient({ id: "builtin" });

  function defaultClientFor(tool: ResolvedTool): InMemoryToolClient {
    if (tool.source === "builtin") return builtinClient;
    const id = `${tool.pluginId}:${tool.runtimeId}`;
    const existing = clients.get(id);
    if (existing instanceof InMemoryToolClient) return existing;
    const client = new InMemoryToolClient({ id });
    clients.set(id, client);
    return client;
  }

  return {
    register(resolved: ResolvedTool, client?: ToolClient): void {
      tools.set(resolved.fullName, resolved);
      const owner = client ?? defaultClientFor(resolved);
      clients.set(owner.id, owner);
      clientByTool.set(resolved.fullName, owner);
      if (owner instanceof InMemoryToolClient) {
        owner.register(resolved);
      }
    },

    registerClient(
      client: ToolClient,
      resolvedTools: readonly ResolvedTool[],
    ): void {
      clients.set(client.id, client);
      for (const resolved of resolvedTools) {
        tools.set(resolved.fullName, resolved);
        clientByTool.set(resolved.fullName, client);
        if (client instanceof InMemoryToolClient) {
          client.register(resolved);
        }
      }
    },

    getByFullName(fullName: string): ResolvedTool | undefined {
      return tools.get(fullName);
    },

    getClientEntry(fullName: string): ToolClientEntry | undefined {
      const tool = tools.get(fullName);
      const client = clientByTool.get(fullName);
      return tool && client ? { tool, client } : undefined;
    },

    getClientForTool(fullName: string): ToolClient | undefined {
      return clientByTool.get(fullName);
    },

    getToolsForRuntime(
      pluginId: string,
      runtimeId: string,
      manifest: RuntimeManifest,
    ): readonly ResolvedTool[] {
      const result: ResolvedTool[] = [];
      const builtinNames = new Set(manifest.tools?.builtin ?? []);
      const localPaths = new Set(manifest.tools?.local ?? []);

      for (const resolved of tools.values()) {
        if (
          resolved.source === "builtin" &&
          builtinNames.has(resolved.localName)
        ) {
          result.push(resolved);
        } else if (
          resolved.source === "local" &&
          resolved.pluginId === pluginId &&
          resolved.runtimeId === runtimeId &&
          hasMatchingLocalPath(localPaths, resolved.localName)
        ) {
          result.push(resolved);
        }
      }

      return result;
    },

    unregisterPlugin(pluginId: string): void {
      for (const [fullName, resolved] of tools) {
        if (resolved.pluginId === pluginId) {
          tools.delete(fullName);
          const client = clientByTool.get(fullName);
          clientByTool.delete(fullName);
          if (client instanceof InMemoryToolClient) {
            client.unregisterFullName(fullName);
          }
        }
      }
    },

    get size(): number {
      return tools.size;
    },
  };
}

/**
 * Check if a local tool name matches any of the declared local paths.
 * Local paths are like './tools/my-tool.js' — we extract the basename without extension.
 */
function hasMatchingLocalPath(
  localPaths: ReadonlySet<string>,
  localName: string,
): boolean {
  for (const path of localPaths) {
    const basename =
      path
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    if (basename === localName) {
      return true;
    }
  }
  return false;
}
