import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import { useLocalePreference } from "@/hooks/useLocalePreference.js";
import { localeDefinitions } from "@/i18n/catalog-registry.js";
import { TOTAL_STEPS } from "./constants.js";
import type { OnboardingStep } from "./types.js";

export function LocaleToggle() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocalePreference();
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {t("onboarding.language")}
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
        className="max-w-44 rounded-(--radius-control) border border-border bg-background px-2 py-1.5 text-foreground"
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

export function StepIndicator({ step }: { step: OnboardingStep }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("onboarding.progress", { current: step + 1, total: TOTAL_STEPS })}
      </p>
      <ol className="flex gap-2" aria-label={t("onboarding.guide")}>
        {["introLabel", "modelsLabel", "playLabel"].map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? "step" : undefined}
            className={`flex-1 border-t-2 pt-1.5 text-xs ${index <= step ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
          >
            {t(`onboarding.${label}`)}
          </li>
        ))}
      </ol>
    </div>
  );
}
