import { resolve } from "node:path";
import {
  createPluginHost,
  createCommandBus,
  type PluginHost,
  type CommandBus,
} from "@covel/plugin-runtime";
import {
  bootstrapKernel,
  type Kernel,
  type KernelInstance,
  type KernelSession,
} from "@covel/kernel";
import type { AiStack } from "./ai-setup.js";

export interface KernelStack {
  pluginHost: PluginHost;
  /** Bootstrap-level kernel instance (shared infra). */
  instance: KernelInstance;
  /** Default session (backward-compat — used by routes that don't manage sessions). */
  kernel: Kernel;
  commandBus: CommandBus;
  /**
   * Get or create a KernelSession for the given session ID.
   * Each session has its own plugin scope (subset of globally loaded plugins).
   */
  getOrCreateSession(sessionId: string, options?: {
    activePlugins?: readonly string[];
  }): KernelSession;
  /** Remove a cached KernelSession (e.g. when session is archived). */
  removeSession(sessionId: string): void;
}

/**
 * Initialize the kernel stack: load plugins and bootstrap the kernel.
 */
export async function initKernelStack(aiStack: AiStack): Promise<KernelStack> {
  const gateway = aiStack.gateway;
  const pluginHost = createPluginHost();

  // Load plugins from the plugins/ directory
  const pluginsDir = resolve(import.meta.dirname, "../../../plugins");
  try {
    const loaded = await pluginHost.loadFromDirectory(pluginsDir);
    console.log(
      `[kernel-setup] Loaded ${loaded.length} plugin(s):`,
      loaded.map((p) => p.manifest.id).join(", ")
    );
  } catch (err) {
    console.warn("[kernel-setup] Failed to load plugins:", err);
  }

  // Bootstrap kernel instance (shared infra)
  const instance = bootstrapKernel({ pluginHost, gateway, slotRegistry: aiStack.slotRegistry });

  // Create a default session for backward-compat routes
  const defaultSession = instance.createSession();
  const kernel: Kernel = {
    executeTurn: defaultSession.executeTurn,
    setContext: defaultSession.setContext,
  };

  const commandBus = createCommandBus(pluginHost.commandRegistry);

  // Per-session KernelSession cache
  const MAX_CACHED_SESSIONS = 500;
  const sessionMap = new Map<string, KernelSession>();

  function getOrCreateSession(
    sessionId: string,
    options?: { activePlugins?: readonly string[] },
  ): KernelSession {
    let session = sessionMap.get(sessionId);
    if (!session) {
      // Evict oldest entry when cache is full
      if (sessionMap.size >= MAX_CACHED_SESSIONS) {
        const oldest = sessionMap.keys().next().value;
        if (oldest) sessionMap.delete(oldest);
      }
      session = instance.createSession({
        activePlugins: options?.activePlugins,
      });
      sessionMap.set(sessionId, session);
    }
    return session;
  }

  function removeSession(sessionId: string): void {
    sessionMap.delete(sessionId);
  }

  return { pluginHost, instance, kernel, commandBus, getOrCreateSession, removeSession };
}
