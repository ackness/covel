import { z } from "zod";
import type { SettingsStoreApi } from "@covel/shared";
import { registerThemeSettings } from "@/theme-system/settings.js";

/**
 * Core/general user preferences that apply app-wide regardless of session.
 */
export function registerCoreSettings(store: SettingsStoreApi): void {
  store.register({
    key: "ui.locale",
    schema: z.enum(["zh-CN", "en-US"]),
    default: "zh-CN",
    group: "general",
    widget: "select",
    label: { "zh-CN": "语言", "en-US": "Language" },
    options: [
      {
        value: "zh-CN",
        label: { "zh-CN": "简体中文", "en-US": "Chinese (Simplified)" },
      },
      {
        value: "en-US",
        label: { "zh-CN": "English", "en-US": "English" },
      },
    ],
  });

  registerThemeSettings(store);

  store.register({
    key: "ui.onboardedVersion",
    schema: z.number().int(),
    default: 0,
    group: "general",
    widget: "number",
    label: { "zh-CN": "Onboarding 版本", "en-US": "Onboarding version" },
  });
}
