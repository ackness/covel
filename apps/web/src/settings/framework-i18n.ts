import type { TFunction } from "i18next";
import type { SettingEntry, SettingOption } from "@covel/settings";
import { localeTier, resolveI18nText } from "@covel/shared";
import i18n from "@/i18n";

type SettingTextField = "label" | "description";

function frameworkSettingText(
  t: TFunction,
): Readonly<Record<string, Partial<Record<SettingTextField, string>>>> {
  return {
    "ui.appearance": {
      label: t("settings.frameworkEntries.uiAppearance.label", "Appearance"),
      description: t(
        "settings.frameworkEntries.uiAppearance.description",
        "Choose the active interface style. Imported custom themes appear here automatically.",
      ),
    },
    "ui.scheme": {
      label: t("settings.frameworkEntries.uiScheme.label", "Color scheme"),
      description: t(
        "settings.frameworkEntries.uiScheme.description",
        "Choose light or dark. Single-scheme themes automatically lock to the supported mode.",
      ),
    },
    "ui.themeManager": {
      label: t(
        "settings.frameworkEntries.uiThemeManager.label",
        "Theme Library",
      ),
      description: t(
        "settings.frameworkEntries.uiThemeManager.description",
        "Import, remove, and reuse custom theme packages.",
      ),
    },
    "ui.locale": {
      label: t(
        "settings.frameworkEntries.uiLocale.label",
        "Interface Language",
      ),
      description: t(
        "settings.frameworkEntries.uiLocale.description",
        "A language marked experimental has a translated interface. The instructions the models read stay in English, so the quality of the story depends on the model.",
      ),
    },
    "ui.chatMessageWindow": {
      label: t(
        "settings.frameworkEntries.chatMessageWindow.label",
        "Chat window message limit",
      ),
      description: t(
        "settings.frameworkEntries.chatMessageWindow.description",
        "How many messages stay loaded in the chat. Older messages leave the window and load again when you scroll up.",
      ),
    },
    "ui.expandTurnUpdates": {
      label: t(
        "settings.frameworkEntries.expandTurnUpdates.label",
        "Expand turn updates",
      ),
      description: t(
        "settings.frameworkEntries.expandTurnUpdates.description",
        "Show codex discoveries, achievements, and status cards open under each turn instead of folded into one line.",
      ),
    },
    "audio.musicEnabled": {
      label: t(
        "settings.frameworkEntries.musicEnabled.label",
        "Background music",
      ),
      description: t(
        "settings.frameworkEntries.musicEnabled.description",
        "Play the music of a world during a session. A world plays music only when it ships tracks and a plugin that chooses them is on.",
      ),
    },
    "audio.musicVolume": {
      label: t("settings.frameworkEntries.musicVolume.label", "Music volume"),
      description: t(
        "settings.frameworkEntries.musicVolume.description",
        "From 0 to 100. The music lowers itself while a narrated line plays.",
      ),
    },
    "world.authoringIdleTimeoutSeconds": {
      label: t(
        "settings.frameworkEntries.worldAuthoringIdleTimeout.label",
        "World authoring: wait for the model (seconds)",
      ),
      description: t(
        "settings.frameworkEntries.worldAuthoringIdleTimeout.description",
        "How long creating, revising or translating a world waits when the model sends nothing. A model that keeps writing is never cut off, however long the whole answer takes. Raise this when a slow model needs a long time before its first words.",
      ),
    },
    "ui.onboardedVersion": {
      label: t(
        "settings.frameworkEntries.onboardedVersion.label",
        "Onboarding version",
      ),
    },
    "llm.slotConfig": {
      label: t(
        "settings.frameworkEntries.llmSlotConfig.label",
        "Model role assignments",
      ),
      description: t(
        "settings.frameworkEntries.llmSlotConfig.description",
        "Choose a provider and model for each model role",
      ),
    },
    "llm.providers": {
      label: t(
        "settings.frameworkEntries.llmProviders.label",
        "Providers and models",
      ),
    },
    "llm.providerPriceMultipliers": {
      label: t(
        "settings.frameworkEntries.llmProviderPriceMultipliers.label",
        "Provider price multipliers",
      ),
    },
    "llm.paramOverrides": {
      label: t(
        "settings.frameworkEntries.llmParamOverrides.label",
        "Parameter overrides",
      ),
    },
    "llm.capabilityOverrides": {
      label: t(
        "settings.frameworkEntries.llmCapabilityOverrides.label",
        "Capability overrides",
      ),
    },
    "media.allowedImageHosts": {
      label: t(
        "settings.frameworkEntries.mediaAllowedImageHosts.label",
        "Image hosts allowed per world",
      ),
    },
    "llm.prepRuntimeBindings": {
      label: t(
        "settings.frameworkEntries.llmPrepRuntimeBindings.label",
        "Prep-phase runtime bindings",
      ),
    },
  };
}

/** Resolve built-in framework metadata from the Web catalog, preserving plugin I18nText. */
export function resolveSettingEntryText(
  entry: SettingEntry,
  field: SettingTextField,
  locale: string,
): string {
  const fallback = resolveI18nText(entry[field], locale) ?? "";
  if (entry.pluginId) return fallback;
  return (
    frameworkSettingText(i18n.getFixedT(locale))[entry.key]?.[field] ?? fallback
  );
}

/** Resolve options owned by the Web framework while preserving package/plugin labels. */
export function resolveSettingOptionText(
  entry: SettingEntry,
  option: SettingOption,
  locale: string,
): string {
  const fallback = resolveI18nText(option.label, locale) ?? option.value;
  if (!entry.pluginId && entry.key === "ui.locale") {
    // Each language is named in itself, as in the other language switchers.
    const name = resolveI18nText(option.label, option.value) ?? option.value;
    return localeTier(option.value) === "extended"
      ? `${name} (${i18n.getFixedT(locale)("onboarding.languageExperimental", "experimental")})`
      : name;
  }
  if (entry.pluginId || entry.key !== "ui.scheme") return fallback;
  if (option.value !== "light" && option.value !== "dark") return fallback;
  return i18n.getFixedT(locale)(
    `settings.themeScheme.${option.value}`,
    fallback,
  );
}
