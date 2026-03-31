import type { HookEvent, PublicHookDefinition } from "@covel/shared";
import type { RegisteredHook, HookHandler } from "../types.js";

/**
 * Registry for hook handlers, organized by lifecycle event.
 *
 * Hooks for the same event are sorted by:
 * 1. loadingOrder (ascending, lower = earlier)
 * 2. registration order (stable)
 */
export function createHookRegistry() {
  const hooks = new Map<HookEvent, RegisteredHook[]>();

  function ensureList(event: HookEvent): RegisteredHook[] {
    let list = hooks.get(event);
    if (!list) {
      list = [];
      hooks.set(event, list);
    }
    return list;
  }

  function register(
    pluginId: string,
    definition: PublicHookDefinition,
    handler: HookHandler,
    loadingOrder: number
  ): void {
    const list = ensureList(definition.event);
    list.push({ pluginId, definition, handler, loadingOrder });
    // Re-sort by loadingOrder (stable sort preserves registration order for equal values)
    list.sort((a, b) => a.loadingOrder - b.loadingOrder);
  }

  /**
   * Get all hooks for an event, optionally filtered by match criteria.
   */
  function getHooksForEvent(
    event: HookEvent,
    context?: { toolId?: string; runtimeId?: string; pluginId?: string }
  ): RegisteredHook[] {
    const list = hooks.get(event) ?? [];
    if (!context) return list;

    return list.filter((hook) => {
      const match = hook.definition.match;
      if (!match) return true;

      if (match.toolIds && context.toolId && !match.toolIds.includes(context.toolId)) {
        return false;
      }
      if (match.runtimeIds && context.runtimeId && !match.runtimeIds.includes(context.runtimeId)) {
        return false;
      }
      if (match.pluginIds && context.pluginId && !match.pluginIds.includes(context.pluginId)) {
        return false;
      }

      return true;
    });
  }

  /** Remove all hooks for a plugin. */
  function removeByPlugin(pluginId: string): void {
    for (const [event, list] of hooks) {
      const filtered = list.filter((h) => h.pluginId !== pluginId);
      if (filtered.length === 0) {
        hooks.delete(event);
      } else {
        hooks.set(event, filtered);
      }
    }
  }

  /** List all registered hooks. */
  function listAll(): RegisteredHook[] {
    const result: RegisteredHook[] = [];
    for (const list of hooks.values()) {
      result.push(...list);
    }
    return result;
  }

  return {
    register,
    getHooksForEvent,
    removeByPlugin,
    listAll,
  };
}

export type HookRegistry = ReturnType<typeof createHookRegistry>;
