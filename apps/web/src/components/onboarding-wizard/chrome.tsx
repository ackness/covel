import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { TOTAL_STEPS } from "./constants.js";
import type { LocaleControlsProps, OnboardingStep } from "./types.js";

export function LocaleToggle({ locale, setLocale }: LocaleControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="absolute top-3 left-3 sm:top-6 sm:left-6 flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest z-10">
      <button
        type="button"
        onClick={() => setLocale("zh-CN")}
        className={`px-2 py-1 border transition-colors ${
          locale === "zh-CN"
            ? "border-primary text-primary"
            : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
        }`}
        aria-label={t("onboarding.localeZh", "Switch to Chinese")}
      >
        {"\u4E2D"}
      </button>
      <button
        type="button"
        onClick={() => setLocale("en-US")}
        className={`px-2 py-1 border transition-colors ${
          locale === "en-US"
            ? "border-primary text-primary"
            : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
        }`}
        aria-label={t("onboarding.localeEn", "Switch to English")}
      >
        EN
      </button>
    </div>
  );
}

export function CloseButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      onClick={onDismiss}
      className="absolute top-3 right-3 sm:top-6 sm:right-6 text-muted-foreground hover:text-foreground transition-colors z-10"
      aria-label="Close"
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
