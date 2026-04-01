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
import type { GatewayLike } from "@covel/runtime";

export interface KernelStack {
  pluginHost: PluginHost;
  /** Bootstrap-level kernel instance (shared infra). */
  instance: KernelInstance;
  /** Default session (backward-compat — used by routes that don't manage sessions). */
  kernel: Kernel;
  commandBus: CommandBus;
}

/**
 * Initialize the kernel stack: load plugins and bootstrap the kernel.
 */
export async function initKernelStack(gateway: GatewayLike): Promise<KernelStack> {
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
  const instance = bootstrapKernel({ pluginHost, gateway });

  // Create a default session for backward-compat routes
  const defaultSession = instance.createSession();
  const kernel: Kernel = {
    executeTurn: defaultSession.executeTurn,
    setContext: defaultSession.setContext,
  };

  const commandBus = createCommandBus(pluginHost.commandRegistry);

  return { pluginHost, instance, kernel, commandBus };
}
