import type { PublicRuntimeSpec } from "@covel/shared";
import type { RuntimeHandler } from "../types.js";

/** Runtime spec with resolved plugin metadata. */
export interface RegisteredRuntime {
  pluginId: string;
  spec: PublicRuntimeSpec;
  /** Absolute path to PLUGIN.md instructions, if available. */
  instructionsPath?: string;
  /** Custom handler (if set, kernel uses this instead of LLM). */
  handler?: RuntimeHandler;
}

/**
 * Registry for runtime specs from all plugins.
 * Runtimes are keyed by qualified ID: `pluginId:runtimeId`.
 */
export function createRuntimeRegistry() {
  const runtimes = new Map<string, RegisteredRuntime>();

  function qualifiedId(pluginId: string, runtimeId: string): string {
    return `${pluginId}:${runtimeId}`;
  }

  function register(
    pluginId: string,
    spec: PublicRuntimeSpec,
    instructionsPath?: string
  ): void {
    const qid = qualifiedId(pluginId, spec.id);
    if (runtimes.has(qid)) {
      throw new Error(`Runtime "${qid}" is already registered.`);
    }
    runtimes.set(qid, { pluginId, spec, instructionsPath });
  }

  /** Set a custom handler for a runtime. */
  function setHandler(pluginId: string, runtimeId: string, handler: RuntimeHandler): void {
    const qid = qualifiedId(pluginId, runtimeId);
    const rt = runtimes.get(qid);
    if (!rt) {
      throw new Error(`Runtime "${qid}" not found, cannot set handler.`);
    }
    rt.handler = handler;
  }

  function get(
    pluginId: string,
    runtimeId: string
  ): RegisteredRuntime | undefined {
    return runtimes.get(qualifiedId(pluginId, runtimeId));
  }

  function getByQualifiedId(qid: string): RegisteredRuntime | undefined {
    return runtimes.get(qid);
  }

  /** List all runtimes for a specific plugin. */
  function listByPlugin(pluginId: string): RegisteredRuntime[] {
    return Array.from(runtimes.values()).filter(
      (r) => r.pluginId === pluginId
    );
  }

  /** List all registered runtimes. */
  function listAll(): RegisteredRuntime[] {
    return Array.from(runtimes.values());
  }

  /** Remove all runtimes for a plugin. */
  function removeByPlugin(pluginId: string): void {
    for (const [key, runtime] of runtimes) {
      if (runtime.pluginId === pluginId) {
        runtimes.delete(key);
      }
    }
  }

  return {
    register,
    setHandler,
    get,
    getByQualifiedId,
    listByPlugin,
    listAll,
    removeByPlugin,
  };
}

export type RuntimeRegistry = ReturnType<typeof createRuntimeRegistry>;
