import { join } from "node:path";
import {
  patchDesktopConfigFile,
  readDesktopConfigFile,
} from "@covel/shared/desktop-config/node";
import {
  normalizeOutboundProxyConfig,
  type OutboundProxyConfig,
  type OutboundProxyMode,
} from "@covel/ai-provider";

export function readStoredProxyConfig(
  covelHome: string,
  defaultMode: OutboundProxyMode = "direct",
): OutboundProxyConfig {
  const file = join(covelHome, "config.toml");
  try {
    const config = readDesktopConfigFile(file);
    const mode = config.network?.proxy_mode ?? defaultMode;
    const url = config.network?.proxy_url;
    return normalizeOutboundProxyConfig({ mode, ...(url ? { url } : {}) });
  } catch (error) {
    // Sidecar startup remains available for recovery. The strict writer below
    // will refuse to replace this invalid file until the operator repairs it.
    console.warn(
      `[proxy-config] Invalid config.toml; using ${defaultMode} mode:`,
      error,
    );
    return { mode: defaultMode };
  }
}

export function writeStoredProxyConfig(
  covelHome: string,
  config: OutboundProxyConfig,
): void {
  const normalized = normalizeOutboundProxyConfig(config);
  const file = join(covelHome, "config.toml");
  patchDesktopConfigFile(file, {
    network: {
      proxy_mode: normalized.mode,
      proxy_url: normalized.url ?? "",
    },
  });
}
