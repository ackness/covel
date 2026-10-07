import { useRef, useState } from "react";
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
import { emitToast } from "@/lib/toast-channel.js";
import { getSettings } from "@/settings/store.js";
import { LocaleToggle, StepIndicator } from "./onboarding-wizard/chrome.js";
import { markOnboarded } from "./onboarding-wizard/persistence.js";
import { ModelStep, PlayStep, WelcomeStep } from "./onboarding-wizard/steps.js";
import { boundTextSlots } from "./onboarding-wizard/model-state.js";
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
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const slots = boundTextSlots(resolvedSlots);
  const dismiss = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await markOnboarded();
    } catch (error) {
      // The guide closes either way. Settings that failed to load are
      // read-only, so a guide that waits for this write never closes. It
      // opens again on the next launch instead.
      console.error("[onboarding] completion was not saved", error);
      emitToast(
        "error",
        t(
          getSettings().isHydrated()
            ? "settings.saveFailed"
            : "settings.loadFailedReadOnly",
        ),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
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
        aria-busy={saving}
        showCloseButton={!saving}
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
              hasModel={slots.some((slot) => slot.hasCredentials === true)}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          {step === 0 ? (
            <Button variant="ghost" onClick={dismiss} disabled={saving}>
              {t("onboarding.browseFirst")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setStep((step - 1) as OnboardingStep)}
            >
              {t("onboarding.back")}
            </Button>
          )}
          <Button
            disabled={saving}
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
