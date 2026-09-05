import i18n from "i18next";
import { emitToast } from "@/lib/toast-channel.js";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { registerPluginUserSettings } from "@/settings/registry/plugin.js";
import { getSettings, registerKnownProviders } from "@/settings/store.js";
import type { SessionDispatch } from "./types.js";

interface BootSessionStoreOptions {
  dispatch: SessionDispatch;
  ds: DataService;
}

async function loadProviderKeysFromServer(): Promise<void> {
  const keys = await api.fetchServerProviderKeys();

  const validKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (key.length <= 64 && value.length <= 256) {
      validKeys[key] = value;
    }
  }

  const existing = api.getProviderKeys();
  if (Object.keys(existing).length === 0 && Object.keys(validKeys).length > 0) {
    api.setProviderKeys(validKeys);
  }
}

export async function bootSessionStore({
  dispatch,
  ds,
}: BootSessionStoreOptions): Promise<void> {
  try {
    const [presets, pluginsRes, worlds, llmConfig] = await Promise.all([
      api.listPresets(),
      api.getPluginCatalog(),
      ds.listWorlds(),
      api.fetchLlmConfig().catch(() => null),
    ]);

    // Slot ids offered to `type: slot` settings — llm.toml sections plus any
    // slot the player defined client-side. Options only: the schema stays a
    // bare string so a slot added after boot is still accepted.
    const slotIds = [
      ...new Set([
        ...Object.keys(llmConfig?.slots ?? {}),
        ...Object.keys(api.getSlotConfig()),
      ]),
    ].sort((a, b) => a.localeCompare(b));

    for (const plugin of pluginsRes.items) {
      if (plugin.userSettings.length > 0) {
        registerPluginUserSettings(
          getSettings(),
          plugin.id,
          plugin.userSettings,
          slotIds,
        );
      }
    }

    if (llmConfig?.providers && llmConfig.providers.length > 0) {
      registerKnownProviders(llmConfig.providers);
    }

    dispatch({
      type: "BOOT_SUCCESS",
      presets,
      plugins: pluginsRes.items,
      pluginLoadErrors: pluginsRes.loadErrors,
      worlds,
      llmConfig,
    });

    try {
      await loadProviderKeysFromServer();
    } catch {
      // Provider keys endpoint is optional in web/local deployments.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dispatch({ type: "BOOT_ERROR", error: message });
    emitToast(
      "error",
      i18n.t("toast.bootFailed", {
        defaultValue: "Failed to initialise session",
      }) as string,
      message,
    );
  }
}
