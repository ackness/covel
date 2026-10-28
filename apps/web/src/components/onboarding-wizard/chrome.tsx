import { useTranslation } from "react-i18next";
import { TOTAL_STEPS } from "./constants.js";
import type { OnboardingStep } from "./types.js";

export function StepIndicator({ step }: { step: OnboardingStep }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("onboarding.progress", { current: step + 1, total: TOTAL_STEPS })}
      </p>
      <ol className="flex gap-2" aria-label={t("onboarding.guide")}>
        {["language", "introLabel", "modelsLabel", "playLabel"].map(
          (label, index) => (
            <li
              key={label}
              aria-current={step === index ? "step" : undefined}
              className={`flex-1 border-t-2 pt-1.5 text-xs ${index <= step ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
            >
              {t(`onboarding.${label}`)}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
