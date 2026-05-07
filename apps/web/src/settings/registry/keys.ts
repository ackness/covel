import { z } from "zod";
import type { SettingsStoreApi } from "@covel/shared";

/**
 * Register a setting entry per known provider so the Settings UI shows a
 * per-provider secret input. Backed by `keys.env` (mode 600) on desktop and
 * `covel:keys` localStorage on web — the SettingsStore routes based on the
 * `backend: 'keys'` marker.
 *
 * Safe to call multiple times: the registry overwrites by key.
 */
export function registerProviderKeys(
  store: SettingsStoreApi,
  providers: readonly string[],
): void {
  for (const provider of providers) {
    store.register({
      key: `keys.${provider}`,
      schema: z.string(),
      default: "",
      group: "llm",
      backend: "keys",
      secret: true,
      widget: "secret",
      label: provider.charAt(0).toUpperCase() + provider.slice(1),
    });
  }
}
