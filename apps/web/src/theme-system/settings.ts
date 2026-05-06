import type { SettingsStoreApi } from "@covel/shared";
import { primeThemeRegistry } from "./registry.js";

export function registerThemeSettings(store: SettingsStoreApi): void {
	primeThemeRegistry(store);
}
