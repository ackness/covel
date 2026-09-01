import type { TFunction } from "i18next";
import type { SettingEntry, SettingOption } from "@covel/settings";
import { resolveI18nText } from "@covel/shared";
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
    },
    "ui.chatMessageWindow": {
      label: t(
        "settings.frameworkEntries.chatMessageWindow.label",
        "Chat window message limit",
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
  if (entry.pluginId || entry.key !== "ui.scheme") return fallback;
  if (option.value !== "light" && option.value !== "dark") return fallback;
  return i18n.getFixedT(locale)(
    `settings.themeScheme.${option.value}`,
    fallback,
  );
}
