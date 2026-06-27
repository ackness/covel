import type { SettingsStoreApi } from "@covel/settings";
import { primeThemeRegistry } from "./registry.js";

export function registerThemeSettings(store: SettingsStoreApi): void {
  primeThemeRegistry(store);
}
