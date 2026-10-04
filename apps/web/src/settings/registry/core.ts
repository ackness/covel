import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import { WORLD_AUTHORING_IDLE_TIMEOUT_MS } from "@covel/shared";
import { localeDefinitions, localeRegistry } from "@/i18n/catalog-registry.js";
import { resolveInitialLocale } from "@/i18n/locale-detector.js";
import { registerThemeSettings } from "@/theme-system/settings.js";

export const WORLD_AUTHORING_IDLE_TIMEOUT_SETTING =
  "world.authoringIdleTimeoutSeconds";

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
    description:
      "A language marked experimental has a translated interface. The instructions the models read stay in English, so the quality of the story depends on the model.",
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
    key: "ui.expandTurnUpdates",
    schema: z.boolean(),
    default: false,
    group: "general",
    widget: "toggle",
    label: "Expand turn updates",
  });

  store.register({
    key: WORLD_AUTHORING_IDLE_TIMEOUT_SETTING,
    schema: z
      .number()
      .int()
      .min(WORLD_AUTHORING_IDLE_TIMEOUT_MS.settingMin / 1000)
      .max(WORLD_AUTHORING_IDLE_TIMEOUT_MS.max / 1000),
    default: WORLD_AUTHORING_IDLE_TIMEOUT_MS.default / 1000,
    group: "general",
    widget: "number",
    min: WORLD_AUTHORING_IDLE_TIMEOUT_MS.settingMin / 1000,
    max: WORLD_AUTHORING_IDLE_TIMEOUT_MS.max / 1000,
    step: 15,
    label: "World authoring: wait for the model (seconds)",
    description:
      "How long creating, revising or translating a world waits when the model sends nothing. A model that keeps writing is never cut off, however long the whole answer takes. Raise this when a slow model needs a long time before its first words.",
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
