import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import { localeDefinitions, localeRegistry } from "@/i18n/catalog-registry.js";
import { resolveInitialLocale } from "@/i18n/locale-detector.js";
import { registerThemeSettings } from "@/theme-system/settings.js";

/**
 * Core/general user preferences that apply app-wide regardless of session.
 */
export function registerCoreSettings(store: SettingsStoreApi): void {
  store.register({
    key: "ui.locale",
    schema: z
      .string()
      .refine((value) => localeRegistry.codes.some((code) => code === value), {
        message: "Unsupported or non-canonical locale",
      }),
    // Browser-language detection only reaches the player through this default:
    // `main.tsx` applies the store value unconditionally after hydration, so a
    // hardcoded "zh-CN" here meant an English browser flashed English and then
    // flipped to Chinese, permanently. Once the player picks a language the
    // stored value wins and this is never consulted again.
    default: resolveInitialLocale(),
    group: "general",
    widget: "select",
    label: "Interface Language",
    options: localeDefinitions.map(({ code, label }) => ({
      value: code,
      label,
    })),
  });

  registerThemeSettings(store);

  store.register({
    key: "ui.chatMessageWindow",
    schema: z.number().int().min(200).max(20000),
    default: 2000,
    group: "general",
    widget: "number",
    label: "Chat window message limit",
  });

  store.register({
    key: "ui.onboardedVersion",
    schema: z.number().int(),
    default: 0,
    group: "general",
    widget: "number",
    label: "Onboarding version",
  });
}
