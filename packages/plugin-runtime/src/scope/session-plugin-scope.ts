/**
 * Session-scoped plugin activation.
 *
 * Each session maintains its own set of active plugins (a subset of the
 * globally loaded plugin pool). Scoped registry views wrap global registries
 * and filter by the active set — no data duplication.
 *
 * Enabling / disabling a plugin mutates the scope's active set. Because scoped
 * views read from the live set on every call, the change is immediately
 * reflected on the next registry lookup (effectively the next turn).
 */

import type { HookEvent } from "@covel/shared";
import type { PluginRegistry } from "../registry/plugin-registry.js";
import type { RuntimeRegistry, RegisteredRuntime } from "../registry/runtime-registry.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import type { HookRegistry } from "../registry/hook-registry.js";
import type { RegisteredTool, RegisteredHook, RegisteredContextProvider } from "../types.js";

// ── SessionPluginScope ───────────────────────────────────────────

export interface SessionPluginScope {
  /** Check if a plugin is active in this session. */
  isActive(pluginId: string): boolean;
  /** Enable a plugin. Must exist in the global registry. */
  enable(pluginId: string): void;
  /** Disable a plugin. */
  disable(pluginId: string): void;
  /** List all active plugin IDs. */
  listActive(): readonly string[];
  /** List all available (globally loaded) plugin IDs. */
  listAvailable(): readonly string[];
}

export function createSessionPluginScope(
  pluginRegistry: PluginRegistry,
  initialActiveIds?: readonly string[],
): SessionPluginScope {
  const activeIds = new Set<string>(
    initialActiveIds ?? pluginRegistry.listEnabled().map((p) => p.manifest.id),
  );

  // Validate that all initial IDs exist in the global pool
  for (const id of activeIds) {
    if (!pluginRegistry.has(id)) {
      activeIds.delete(id);
    }
  }

  return {
    isActive: (pluginId) => activeIds.has(pluginId),

    enable(pluginId) {
      if (!pluginRegistry.has(pluginId)) {
        throw new Error(
          `Cannot enable plugin "${pluginId}": not loaded in the global registry.`,
        );
      }
      activeIds.add(pluginId);
    },

    disable(pluginId) {
      activeIds.delete(pluginId);
    },

    listActive: () => Array.from(activeIds),

    listAvailable: () => pluginRegistry.list().map((p) => p.manifest.id),
  };
}

// ── Scoped Registry Interfaces ───────────────────────────────────
//
// Read-only subsets of the global registry interfaces. Both the global
// and scoped registries satisfy these shapes (structural typing).

export interface ScopedRuntimeRegistry {
  get(pluginId: string, runtimeId: string): RegisteredRuntime | undefined;
  getByQualifiedId(qid: string): RegisteredRuntime | undefined;
  listByPlugin(pluginId: string): RegisteredRuntime[];
  listAll(): RegisteredRuntime[];
}

export interface ScopedToolRegistry {
  get(pluginId: string, toolId: string): RegisteredTool | undefined;
  getByQualifiedId(qid: string): RegisteredTool | undefined;
  listByPlugin(pluginId: string): RegisteredTool[];
  listAll(): RegisteredTool[];
}

export interface ScopedHookRegistry {
  getHooksForEvent(
    event: HookEvent,
    context?: { toolId?: string; runtimeId?: string; pluginId?: string },
  ): RegisteredHook[];
  listAll(): RegisteredHook[];
}

// ── Scoped Registry Factories ────────────────────────────────────

export function createScopedRuntimeRegistry(
  global: RuntimeRegistry,
  scope: SessionPluginScope,
): ScopedRuntimeRegistry {
  return {
    get(pluginId, runtimeId) {
      if (!scope.isActive(pluginId)) return undefined;
      return global.get(pluginId, runtimeId);
    },
    getByQualifiedId(qid) {
      const entry = global.getByQualifiedId(qid);
      if (!entry || !scope.isActive(entry.pluginId)) return undefined;
      return entry;
    },
    listByPlugin(pluginId) {
      if (!scope.isActive(pluginId)) return [];
      return global.listByPlugin(pluginId);
    },
    listAll() {
      return global.listAll().filter((r) => scope.isActive(r.pluginId));
    },
  };
}

export function createScopedToolRegistry(
  global: ToolRegistry,
  scope: SessionPluginScope,
): ScopedToolRegistry {
  return {
    get(pluginId, toolId) {
      if (!scope.isActive(pluginId)) return undefined;
      return global.get(pluginId, toolId);
    },
    getByQualifiedId(qid) {
      const entry = global.getByQualifiedId(qid);
      if (!entry || !scope.isActive(entry.pluginId)) return undefined;
      return entry;
    },
    listByPlugin(pluginId) {
      if (!scope.isActive(pluginId)) return [];
      return global.listByPlugin(pluginId);
    },
    listAll() {
      return global.listAll().filter((t) => scope.isActive(t.pluginId));
    },
  };
}

export function createScopedHookRegistry(
  global: HookRegistry,
  scope: SessionPluginScope,
): ScopedHookRegistry {
  return {
    getHooksForEvent(event, context) {
      return global
        .getHooksForEvent(event, context)
        .filter((h) => scope.isActive(h.pluginId));
    },
    listAll() {
      return global.listAll().filter((h) => scope.isActive(h.pluginId));
    },
  };
}

/**
 * Create a filtered view of context providers.
 *
 * Returns a standard Map whose iteration methods are proxied
 * to only yield entries for active plugins.
 */
export function createScopedContextProviders(
  global: ReadonlyMap<string, RegisteredContextProvider>,
  scope: SessionPluginScope,
): Map<string, RegisteredContextProvider> {
  const underlying = global as Map<string, RegisteredContextProvider>;
  const proxy: Map<string, RegisteredContextProvider> = new Proxy(underlying, {
    get(target, prop, receiver) {
      if (prop === "values") {
        return function* () {
          for (const entry of target.values()) {
            if (scope.isActive(entry.pluginId)) yield entry;
          }
        };
      }
      if (prop === "entries") {
        return function* () {
          for (const [key, entry] of target.entries()) {
            if (scope.isActive(entry.pluginId)) yield [key, entry] as const;
          }
        };
      }
      if (prop === "forEach") {
        return function (
          this: unknown,
          cb: (value: RegisteredContextProvider, key: string, map: Map<string, RegisteredContextProvider>) => void,
          thisArg?: unknown,
        ) {
          for (const [key, entry] of target.entries()) {
            if (scope.isActive(entry.pluginId)) cb.call(thisArg, entry, key, proxy);
          }
        };
      }
      if (prop === "get") {
        return (key: string) => {
          const entry = target.get(key);
          if (entry && scope.isActive(entry.pluginId)) return entry;
          return undefined;
        };
      }
      if (prop === "has") {
        return (key: string) => {
          const entry = target.get(key);
          return !!entry && scope.isActive(entry.pluginId);
        };
      }
      if (prop === "size") {
        let count = 0;
        for (const entry of target.values()) {
          if (scope.isActive(entry.pluginId)) count++;
        }
        return count;
      }
      if (prop === "keys") {
        return function* () {
          for (const [key, entry] of target.entries()) {
            if (scope.isActive(entry.pluginId)) yield key;
          }
        };
      }
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return () => {
          throw new Error("Cannot mutate scoped registry view");
        };
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (const [key, entry] of target.entries()) {
            if (scope.isActive(entry.pluginId)) yield [key, entry] as [string, RegisteredContextProvider];
          }
        };
      }
      if (prop === Symbol.toStringTag) return "Map";
      return Reflect.get(target, prop, receiver);
    },
  });
  return proxy;
}
