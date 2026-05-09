import {
  ChevronRight,
  Globe,
  KeyRound,
  Package,
  Rocket,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import type { PresetSummary } from "@/services/api.js";
import { CUSTOM_PROVIDER_ID, PROVIDERS } from "./constants.js";
import { ProviderForm } from "./provider-form.js";
import type {
  LocaleControlsProps,
  PluginMode,
  ProviderFormState,
} from "./types.js";

interface WelcomeStepProps extends LocaleControlsProps {
  onNext: () => void;
}

export function WelcomeStep({ locale, setLocale, onNext }: WelcomeStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-8 text-center">
      <div className="space-y-4">
        <div className="flex items-center justify-center">
          <div className="h-12 w-12 rounded-[var(--radius-card)] bg-primary flex items-center justify-center">
            <div className="h-4 w-4 bg-[var(--surface-dialog)] rounded-full" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("onboarding.welcome", "Welcome to Covel")}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
          {t(
            "onboarding.tagline",
            "AI-driven RPG engine. Craft interactive stories powered by large language models.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="ui-eyebrow text-[10px]">
          {t("onboarding.language", "Language")}
        </Label>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setLocale("zh-CN")}
            className={`rounded-[var(--radius-control)] px-4 py-2 text-xs font-medium border transition-colors ${
              locale === "zh-CN"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40"
            }`}
          >
            {"\u4E2D\u6587"}
          </button>
          <button
            onClick={() => setLocale("en-US")}
            className={`rounded-[var(--radius-control)] px-4 py-2 text-xs font-medium border transition-colors ${
              locale === "en-US"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40"
            }`}
          >
            English
          </button>
        </div>
      </div>

      <Button
        onClick={onNext}
        className="w-full text-xs uppercase tracking-widest"
      >
        {t("onboarding.getStarted", "Get Started")}
        <ChevronRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

interface StoryStepProps {
  storyForm: ProviderFormState;
  setStoryForm: (next: ProviderFormState) => void;
  availablePresets: PresetSummary[];
  storyContinueDisabled: boolean;
  onBeforePingStory: () => Promise<void>;
  onContinue: () => void | Promise<void>;
  onSkip: () => void;
}

export function StoryStep({
  storyForm,
  setStoryForm,
  availablePresets,
  storyContinueDisabled,
  onBeforePingStory,
  onContinue,
  onSkip,
}: StoryStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          <h2 className="ui-title text-sm">
            {t("onboarding.narratorModel", "Narrator Model")}
          </h2>
          <code className="text-[10px] text-muted-foreground font-mono">
            covel.story
          </code>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            "onboarding.narratorModelDesc",
            "The core model that drives the main story. Pick a provider and paste your key.",
          )}
        </p>
      </div>

      <ProviderForm
        state={storyForm}
        onChange={setStoryForm}
        onBeforePing={onBeforePingStory}
        presets={availablePresets}
        slotName="story"
      />

      {storyContinueDisabled && (
        <p className="text-[11px] text-amber-500/80 leading-relaxed">
          {t(
            "onboarding.disabledHint",
            "Fill in API Key and Model ID to continue, or skip below to configure later.",
          )}
        </p>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-none text-xs text-muted-foreground"
          onClick={onSkip}
          title={t(
            "onboarding.skipTitle",
            "You can configure this later in Settings.",
          )}
        >
          {t("onboarding.skip", "Skip for now")}
        </Button>
        <div className="flex-1" />
        <Button
          onClick={onContinue}
          className="text-xs uppercase tracking-widest"
          disabled={storyContinueDisabled}
        >
          {t("onboarding.continue", "Continue")}
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface PluginStepProps {
  storySummary: string;
  pluginMode: PluginMode;
  setPluginMode: (next: PluginMode) => void;
  pluginForm: ProviderFormState;
  setPluginForm: (next: ProviderFormState) => void;
  availablePresets: PresetSummary[];
  pluginContinueDisabled: boolean;
  onBeforePingPlugin: () => Promise<void>;
  onBack: () => void;
  onContinue: () => void | Promise<void>;
}

export function PluginStep({
  storySummary,
  pluginMode,
  setPluginMode,
  pluginForm,
  setPluginForm,
  availablePresets,
  pluginContinueDisabled,
  onBeforePingPlugin,
  onBack,
  onContinue,
}: PluginStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" />
          <h2 className="ui-title text-sm">
            {t("onboarding.pluginModel", "Plugin Model")}
          </h2>
          <code className="text-[10px] text-muted-foreground font-mono">
            covel.plugin
          </code>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            "onboarding.pluginModelDesc",
            "Plugins (character tracker, world generator, codex, …) can share the narrator model or use a cheaper one.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <button
          onClick={() => setPluginMode("same")}
          className={`w-full flex items-start gap-3 p-3 rounded-[var(--radius-card)] border text-left transition-colors ${
            pluginMode === "same"
              ? "border-primary bg-primary/10"
              : "border-border hover:border-primary/40"
          }`}
        >
          <div
            className={`mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0 ${
              pluginMode === "same"
                ? "border-primary bg-primary"
                : "border-border"
            }`}
          />
          <div className="min-w-0">
            <div className="text-xs font-medium">
              {t("onboarding.pluginSame", "Use same as narrator")}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono truncate">
              {storySummary}
            </div>
          </div>
        </button>
        <button
          onClick={() => setPluginMode("different")}
          className={`w-full flex items-start gap-3 p-3 rounded-[var(--radius-card)] border text-left transition-colors ${
            pluginMode === "different"
              ? "border-primary bg-primary/10"
              : "border-border hover:border-primary/40"
          }`}
        >
          <div
            className={`mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0 ${
              pluginMode === "different"
                ? "border-primary bg-primary"
                : "border-border"
            }`}
          />
          <div className="min-w-0">
            <div className="text-xs font-medium">
              {t("onboarding.pluginDifferent", "Use a different model")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t(
                "onboarding.pluginDifferentHint",
                "Route plugins to a faster/cheaper provider.",
              )}
            </div>
          </div>
        </button>
      </div>

      {pluginMode === "different" && (
        <ProviderForm
          state={pluginForm}
          onChange={setPluginForm}
          onBeforePing={onBeforePingPlugin}
          presets={availablePresets}
          slotName="plugin"
        />
      )}

      {pluginContinueDisabled && (
        <p className="text-[11px] text-amber-500/80 leading-relaxed">
          {t(
            "onboarding.disabledHint",
            "Fill in API Key and Model ID to continue, or skip below to configure later.",
          )}
        </p>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-none text-xs text-muted-foreground"
          onClick={onBack}
        >
          {t("onboarding.back", "Back")}
        </Button>
        <div className="flex-1" />
        <Button
          onClick={onContinue}
          className="text-xs uppercase tracking-widest"
          disabled={pluginContinueDisabled}
        >
          {t("onboarding.continue", "Continue")}
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface ReadyStepProps {
  onDismiss: () => void;
}

export function ReadyStep({ onDismiss }: ReadyStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-8 text-center">
      <div className="space-y-4">
        <div className="flex items-center justify-center">
          <Rocket className="w-10 h-10 text-primary" />
        </div>
        <h2 className="text-xl font-bold tracking-tight">
          {t("onboarding.ready", "You're all set")}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
          {t(
            "onboarding.readyDesc",
            "Select a world, then start your adventure. You can adjust settings anytime from the top bar.",
          )}
        </p>
      </div>

      <div className="border border-border p-4 text-left space-y-3 rounded-[var(--radius-card)] bg-card/35">
        <div className="flex items-start gap-3">
          <Globe className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <div className="text-xs font-medium">
              {t("onboarding.step1Label", "Pick a world")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t(
                "onboarding.step1Desc",
                "Choose from built-in worlds or create your own.",
              )}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Sparkles className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <div className="text-xs font-medium">
              {t("onboarding.step2Label", "Start your adventure")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t(
                "onboarding.step2Desc",
                "The AI narrator will build a story around you.",
              )}
            </div>
          </div>
        </div>
      </div>

      <Button
        onClick={onDismiss}
        className="w-full text-xs uppercase tracking-widest"
      >
        {t("onboarding.enter", "Enter Covel")}
        <ChevronRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

export function summarizeStoryProvider(storyForm: ProviderFormState): string {
  const storyCustom = storyForm.selected === CUSTOM_PROVIDER_ID;
  if (storyCustom) {
    return (
      (storyForm.customProviderName.trim() || "custom") +
      (storyForm.customModel.trim() ? ` — ${storyForm.customModel.trim()}` : "")
    );
  }

  const storyProvider =
    PROVIDERS.find((p) => p.id === storyForm.selected) ?? PROVIDERS[0];
  return `${storyProvider.name}${storyForm.builtInModel.trim() ? ` — ${storyForm.builtInModel.trim()}` : ""}`;
}

export function isStoryContinueDisabled(storyForm: ProviderFormState): boolean {
  const storyCustom = storyForm.selected === CUSTOM_PROVIDER_ID;
  return (
    !storyForm.apiKey.trim() ||
    (storyCustom
      ? !storyForm.customBaseUrl.trim()
      : !storyForm.builtInModel.trim())
  );
}

export function isPluginContinueDisabled(
  pluginMode: PluginMode,
  pluginForm: ProviderFormState,
): boolean {
  const pluginCustom = pluginForm.selected === CUSTOM_PROVIDER_ID;
  return (
    pluginMode === "different" &&
    (!pluginForm.apiKey.trim() ||
      (pluginCustom
        ? !pluginForm.customBaseUrl.trim()
        : !pluginForm.builtInModel.trim()))
  );
}
