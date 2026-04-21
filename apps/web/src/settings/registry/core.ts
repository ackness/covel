import { z } from "zod";
import type { SettingsStoreApi } from "@covel/shared";

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

  store.register({
    key: "ui.appearance",
    schema: z.enum(["modern", "paper"]),
    default: "paper",
    group: "general",
    widget: "select",
    label: { "zh-CN": "外观", "en-US": "Appearance" },
    options: [
      { value: "paper", label: { "zh-CN": "Paper", "en-US": "Paper" } },
      { value: "modern", label: { "zh-CN": "Modern", "en-US": "Modern" } },
    ],
  });

  store.register({
    key: "ui.onboardedVersion",
    schema: z.number().int(),
    default: 0,
    group: "general",
    widget: "number",
    label: { "zh-CN": "Onboarding 版本", "en-US": "Onboarding version" },
  });
}
