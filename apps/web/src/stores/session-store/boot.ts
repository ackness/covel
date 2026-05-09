import i18n from "i18next";
import { setBlockSchemas } from "@/components/blocks/block-renderer.js";
import { emitToast } from "@/lib/toast-channel.js";
import { migrateLocalStorageToIdb } from "@/services/app-kv-store.js";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { registerPluginUserSettings } from "@/settings/registry/plugin.js";
import { getSettings, registerKnownProviders } from "@/settings/store.js";
import type { BlockSchemaDeclaration } from "@covel/shared";
import type { SessionDispatch } from "./types.js";

interface BootSessionStoreOptions {
  dispatch: SessionDispatch;
  ds: DataService;
}

function isProviderKeyRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadProviderKeysFromServer(): Promise<void> {
  const token = api.getDesktopRestToken?.();
  const res = await fetch(
    "/api/provider-keys",
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  );
  if (!res.ok) return;

  const { keys } = await res.json();
  if (!isProviderKeyRecord(keys)) return;

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
  await migrateLocalStorageToIdb();

  try {
    const [presets, packagesRes, commands, worlds, schemas, llmConfig] =
      await Promise.all([
        api.listPresets(),
        api.listPackages(),
        api.listCommands(),
        ds.listWorlds(),
        api.fetchBlockSchemas().catch(() => ({})),
        api.fetchLlmConfig().catch(() => null),
      ]);

    setBlockSchemas(schemas as Record<string, BlockSchemaDeclaration>);

    for (const pkg of packagesRes.packages) {
      if (pkg.userSettings && pkg.userSettings.length > 0) {
        registerPluginUserSettings(getSettings(), pkg.name, pkg.userSettings);
      }
    }

    if (llmConfig?.providers && llmConfig.providers.length > 0) {
      registerKnownProviders(llmConfig.providers);
    }

    dispatch({
      type: "BOOT_SUCCESS",
      presets,
      packages: packagesRes.packages,
      pluginLoadErrors: packagesRes.loadErrors,
      commands,
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
