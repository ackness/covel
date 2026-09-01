import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { resolveI18nText } from "@covel/shared";
import { localeDefinitions } from "@/i18n/catalog-registry.js";
import { TOTAL_STEPS } from "./constants.js";
import type { LocaleControlsProps, OnboardingStep } from "./types.js";

export function LocaleToggle({ locale, setLocale }: LocaleControlsProps) {
  const { t } = useTranslation();

  return (
    <label className="absolute top-3 left-3 sm:top-6 sm:left-6 z-10">
      <span className="sr-only">{t("onboarding.language", "Language")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
        aria-label={t("onboarding.language", "Language")}
        className="h-8 max-w-44 rounded-(--radius-control) border border-zinc-700 bg-zinc-950 px-2 text-[10px] font-medium tracking-wider text-zinc-300 outline-none transition-colors hover:border-primary/50 focus:border-primary"
      >
        {localeDefinitions.map((definition) => (
          <option key={definition.code} value={definition.code}>
            {resolveI18nText(definition.label, locale) ?? definition.code}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CloseButton({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      onClick={onDismiss}
      className="absolute top-3 right-3 sm:top-6 sm:right-6 text-muted-foreground hover:text-foreground transition-colors z-10"
      aria-label={t("common.close", "Close")}
    >
      <X className="w-5 h-5" />
    </button>
  );
}

export function StepIndicator({ step }: { step: OnboardingStep }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-4 sm:mb-6 shrink-0">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`h-1 transition-all duration-300 ${
            i === step
              ? "w-8 bg-primary"
              : i < step
                ? "w-4 bg-primary/50"
                : "w-4 bg-border"
          }`}
        />
      ))}
    </div>
  );
}
