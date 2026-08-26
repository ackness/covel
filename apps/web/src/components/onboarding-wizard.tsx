import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PresetSummary } from "@/services/api.js";
import { listPresets } from "@/services/api.js";
import { useLocalePreference } from "@/hooks/useLocalePreference";
import { TOTAL_STEPS } from "./onboarding-wizard/constants.js";
import {
  CloseButton,
  LocaleToggle,
  StepIndicator,
} from "./onboarding-wizard/chrome.js";
import {
  bindPluginSlotToStory,
  isOnboarded,
  markOnboarded,
  persistPluginModeSame,
  persistSlot,
} from "./onboarding-wizard/persistence.js";
import {
  defaultModelForProvider,
  emptyFormState,
} from "./onboarding-wizard/provider-state.js";
import {
  isPluginContinueDisabled,
  isStoryContinueDisabled,
  PluginStep,
  ReadyStep,
  StoryStep,
  summarizeStoryProvider,
  WelcomeStep,
} from "./onboarding-wizard/steps.js";
import type {
  OnboardingStep,
  PluginMode,
  ProviderFormState,
} from "./onboarding-wizard/types.js";

export { resetOnboarding } from "./onboarding-wizard/persistence.js";

function nextStep(step: OnboardingStep): OnboardingStep {
  return Math.min(step + 1, TOTAL_STEPS - 1) as OnboardingStep;
}

function previousStep(step: OnboardingStep): OnboardingStep {
  return Math.max(step - 1, 0) as OnboardingStep;
}

function useAvailablePresets(): PresetSummary[] {
  const [availablePresets, setAvailablePresets] = useState<PresetSummary[]>([]);

  useEffect(() => {
    let alive = true;
    void listPresets()
      .then((presets) => {
        if (!alive) return;
        setAvailablePresets(presets.filter((preset) => preset.enabled));
      })
      .catch(() => {
        if (!alive) return;
        setAvailablePresets([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return availablePresets;
}

function useDefaultModelSelection(
  form: ProviderFormState,
  setForm: Dispatch<SetStateAction<ProviderFormState>>,
  availablePresets: PresetSummary[],
): void {
  useEffect(() => {
    if (form.selected === "__custom__" || form.builtInModel.trim()) return;

    const nextModel = defaultModelForProvider(availablePresets, form.selected);
    if (!nextModel) return;

    setForm((current) =>
      current.selected === "__custom__" || current.builtInModel.trim()
        ? current
        : { ...current, builtInModel: nextModel },
    );
  }, [availablePresets, form.selected, form.builtInModel, setForm]);
}

export function OnboardingWizard() {
  const [visible, setVisible] = useState(() => !isOnboarded());
  const { locale, setLocale } = useLocalePreference();
  const [step, setStep] = useState<OnboardingStep>(0);
  const availablePresets = useAvailablePresets();

  const [storyForm, setStoryForm] = useState<ProviderFormState>(() =>
    emptyFormState(),
  );
  const [pluginMode, setPluginMode] = useState<PluginMode>("same");
  const [pluginForm, setPluginForm] = useState<ProviderFormState>(() =>
    emptyFormState(),
  );

  useDefaultModelSelection(storyForm, setStoryForm, availablePresets);
  useDefaultModelSelection(pluginForm, setPluginForm, availablePresets);

  const dismiss = useCallback(() => {
    markOnboarded();
    setVisible(false);
  }, []);

  const handleNext = useCallback(() => {
    if (step < TOTAL_STEPS - 1) {
      setStep((current) => nextStep(current));
      return;
    }
    dismiss();
  }, [step, dismiss]);

  const handleBack = useCallback(() => {
    setStep((current) => previousStep(current));
  }, []);

  const handleBeforePingStory = useCallback(async () => {
    await persistSlot(storyForm, "story", availablePresets);
  }, [storyForm, availablePresets]);

  const handleBeforePingPlugin = useCallback(async () => {
    await persistSlot(pluginForm, "plugin", availablePresets);
  }, [pluginForm, availablePresets]);

  const handleContinueFromStory = useCallback(async () => {
    await persistSlot(storyForm, "story", availablePresets);
    bindPluginSlotToStory();
    setStep((current) => nextStep(current));
  }, [storyForm, availablePresets]);

  const handleContinueFromPlugin = useCallback(async () => {
    if (pluginMode === "different" && pluginForm.apiKey.trim()) {
      await persistSlot(pluginForm, "plugin", availablePresets);
    } else {
      persistPluginModeSame();
    }
    setStep((current) => nextStep(current));
  }, [pluginForm, pluginMode, availablePresets]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm">
      <LocaleToggle locale={locale} setLocale={setLocale} />
      <CloseButton onDismiss={dismiss} />

      <div className="relative w-full max-w-md max-h-full flex flex-col min-h-0">
        <StepIndicator step={step} />

        <div className="ui-dialog-shell border border-border p-5 sm:p-8 overflow-y-auto min-h-0">
          {step === 0 && (
            <WelcomeStep
              locale={locale}
              setLocale={setLocale}
              onNext={handleNext}
            />
          )}

          {step === 1 && (
            <StoryStep
              storyForm={storyForm}
              setStoryForm={setStoryForm}
              availablePresets={availablePresets}
              storyContinueDisabled={isStoryContinueDisabled(storyForm)}
              onBeforePingStory={handleBeforePingStory}
              onContinue={handleContinueFromStory}
              onSkip={handleNext}
            />
          )}

          {step === 2 && (
            <PluginStep
              storySummary={summarizeStoryProvider(storyForm)}
              pluginMode={pluginMode}
              setPluginMode={setPluginMode}
              pluginForm={pluginForm}
              setPluginForm={setPluginForm}
              availablePresets={availablePresets}
              pluginContinueDisabled={isPluginContinueDisabled(
                pluginMode,
                pluginForm,
              )}
              onBeforePingPlugin={handleBeforePingPlugin}
              onBack={handleBack}
              onContinue={handleContinueFromPlugin}
            />
          )}

          {step === 3 && <ReadyStep onDismiss={dismiss} />}
        </div>
      </div>
    </div>
  );
}
