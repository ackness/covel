import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import {
  TRACE_RETENTION_SERVER_SETTING,
  WORLD_AUTHORING_IDLE_TIMEOUT_MS,
} from "@covel/shared";
import { localeDefinitions, localeRegistry } from "@/i18n/catalog-registry.js";
import { resolveInitialLocale } from "@/i18n/locale-detector.js";
import { ALLOWED_IMAGE_HOSTS_SETTING } from "@/lib/external-images.js";
import { registerThemeSettings } from "@/theme-system/settings.js";

export const WORLD_AUTHORING_IDLE_TIMEOUT_SETTING =
  "world.authoringIdleTimeoutSeconds";
export const MUSIC_ENABLED_SETTING = "audio.musicEnabled";
export const MUSIC_VOLUME_SETTING = "audio.musicVolume";

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

  // Written by the "always load images from this host" choice on a held
  // image; there is no editor for it.
  store.register({
    key: ALLOWED_IMAGE_HOSTS_SETTING,
    schema: z.record(z.string(), z.array(z.string())),
    default: {},
    group: "general",
    widget: "custom",
    label: "Image hosts allowed per world",
  });

  store.register({
    key: "ui.chatMessageWindow",
    schema: z.number().int().min(200).max(20000),
    default: 2000,
    group: "general",
    widget: "number",
    min: 200,
    max: 20000,
    step: 100,
    label: "Chat window message limit",
    description:
      "How many messages stay loaded in the chat. Older messages leave the window and load again when you scroll up.",
  });

  store.register({
    key: "ui.expandTurnUpdates",
    schema: z.boolean(),
    default: false,
    group: "general",
    widget: "toggle",
    label: "Expand turn updates",
    description:
      "Show codex discoveries, achievements, and status cards open under each turn instead of folded into one line.",
  });

  store.register({
    key: "ui.developerView",
    schema: z.boolean(),
    default: false,
    group: "general",
    widget: "toggle",
    label: "Developer view",
    description:
      "Show the raw Database tab in the side panel. It lists every stored plugin row, including material meant only for the narrator.",
  });

  store.register({
    // The server prunes traces, so the server keeps this value.
    key: TRACE_RETENTION_SERVER_SETTING.key,
    schema: TRACE_RETENTION_SERVER_SETTING.schema,
    default: TRACE_RETENTION_SERVER_SETTING.default,
    scope: "server",
    group: "general",
    widget: "select",
    options: [
      { value: "7", label: "7 days" },
      { value: "30", label: "30 days" },
      { value: "90", label: "90 days" },
      { value: "keep", label: "Keep everything" },
    ],
    label: "Keep diagnostic traces",
    description:
      "Traces are the debug page's record of each model request and reply. Deleting old ones does not change your story or saves, only what the debug page can show.",
  });

  store.register({
    key: MUSIC_ENABLED_SETTING,
    schema: z.boolean(),
    default: true,
    group: "general",
    widget: "toggle",
    label: "Background music",
    description:
      "Play the music of a world during a session. A world plays music only when it ships tracks and a plugin that chooses them is on.",
  });

  store.register({
    key: MUSIC_VOLUME_SETTING,
    schema: z.number().int().min(0).max(100),
    default: 60,
    group: "general",
    widget: "number",
    min: 0,
    max: 100,
    step: 5,
    label: "Music volume",
    description:
      "From 0 to 100. The music lowers itself while a narrated line plays.",
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
