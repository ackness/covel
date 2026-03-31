import { resolve } from "node:path";
import { createPluginHost, type PluginHost } from "@covel/plugin-runtime";
import { createKernel, type Kernel } from "@covel/kernel";
import type { GatewayLike } from "@covel/runtime";

/**
 * Initialize the kernel stack: load plugins and create the kernel.
 */
export async function initKernelStack(gateway: GatewayLike): Promise<{
  pluginHost: PluginHost;
  kernel: Kernel;
}> {
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

  const kernel = createKernel({ pluginHost, gateway });

  return { pluginHost, kernel };
}
