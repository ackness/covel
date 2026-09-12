import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { LocaleToggle, StepIndicator } from "./onboarding-wizard/chrome.js";
import { markOnboarded } from "./onboarding-wizard/persistence.js";
import { ModelStep, PlayStep, WelcomeStep } from "./onboarding-wizard/steps.js";
import { configuredTextSlots } from "./onboarding-wizard/model-state.js";
import type { OnboardingStep } from "./onboarding-wizard/types.js";

export { resetOnboarding } from "./onboarding-wizard/persistence.js";

interface OnboardingWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settingsOpen: boolean;
  onOpenSettings: (key: string) => void;
  resolvedSlots: ResolvedSlot[];
}

export function OnboardingWizard({
  open,
  onOpenChange,
  settingsOpen,
  onOpenSettings,
  resolvedSlots,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<OnboardingStep>(0);
  const slots = configuredTextSlots(resolvedSlots);
  const dismiss = () => {
    markOnboarded();
    onOpenChange(false);
    setStep(0);
  };
  const stepNames = ["welcome", "modelsTitle", "playTitle"] as const;

  return (
    <Dialog
      open={open && !settingsOpen}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl flex-col gap-5 p-5 sm:p-7"
        data-testid="onboarding-wizard"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 gap-3 text-left">
          <LocaleToggle />
          <StepIndicator step={step} />
          <DialogTitle>{t(`onboarding.${stepNames[step]}`)}</DialogTitle>
          <DialogDescription>
            {t(`onboarding.${["tagline", "modelsDesc", "playDesc"][step]}`)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto space-y-4 pr-1">
          {step === 0 && <WelcomeStep />}
          {step === 1 && (
            <ModelStep slots={slots} onOpenSettings={onOpenSettings} />
          )}
          {step === 2 && (
            <PlayStep
              hasModel={slots.length > 0}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          {step === 0 ? (
            <Button variant="ghost" onClick={dismiss}>
              {t("onboarding.browseFirst")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setStep((step - 1) as OnboardingStep)}
            >
              {t("onboarding.back")}
            </Button>
          )}
          <Button
            onClick={() => {
              if (step === 2) dismiss();
              else setStep((step + 1) as OnboardingStep);
            }}
          >
            {t(
              step === 0
                ? "onboarding.getStarted"
                : step === 1
                  ? "onboarding.learnToPlay"
                  : "onboarding.chooseWorld",
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
