import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  ChevronRight,
  KeyRound,
  Rocket,
  Package,
  Eye,
  EyeOff,
  Globe,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  getProviderKeys,
  setProviderKeys,
  getCustomPresets,
  setCustomPresets,
  uid,
  listPresets,
  getSlotConfig,
  setSlotConfig,
} from "@/services/api.js";
import type { PresetSummary, CustomPreset } from "@/services/api.js";
import {
  PingButton,
  invalidatePingResult,
} from "@/components/shared/ping-button.js";
import { useLocalePreference } from "@/hooks/useLocalePreference";
import { getSettings } from "@/settings/store";

/**
 * Onboarding persistence uses a version number rather than a boolean so that
 * we can re-show the wizard after a tutorial has been materially updated.
 * Bump ONBOARDING_VERSION whenever the wizard flow changes in a way that
 * existing users should see again.
 */
const ONBOARDING_VERSION = 3;
const CUSTOM_PROVIDER_ID = "__custom__";

const PROVIDERS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    placeholder: "sk-...",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "openai",
    name: "OpenAI",
    placeholder: "sk-...",
    keyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    placeholder: "sk-ant-...",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "dashscope",
    name: "DashScope",
    placeholder: "sk-...",
    keyEnv: "DASHSCOPE_API_KEY",
  },
] as const;

const TOTAL_STEPS = 4;

function isOnboarded(): boolean {
  const stored = getSettings().get<number>("ui.onboardedVersion");
  return typeof stored === "number" && stored >= ONBOARDING_VERSION;
}

function markOnboarded(): void {
  void getSettings().set("ui.onboardedVersion", ONBOARDING_VERSION);
}

/** Force the onboarding wizard to appear again on next mount. Used by Settings "re-run tutorial". */
export function resetOnboarding(): void {
  void getSettings().clear("ui.onboardedVersion");
}

interface ProviderFormState {
  selected: string;
  apiKey: string;
  keyVisible: boolean;
  builtInModel: string;
  customBaseUrl: string;
  customModel: string;
  customProviderName: string;
}

function emptyFormState(initialProvider = "deepseek"): ProviderFormState {
  return {
    selected: initialProvider,
    apiKey: "",
    keyVisible: false,
    builtInModel: "",
    customBaseUrl: "",
    customModel: "",
    customProviderName: "",
  };
}

/**
 * Drop stale cached Ping results when the form inputs change — otherwise a
 * green badge from a previous URL/key combination can linger and mislead.
 */
function clearCachedPing(slotName: "story" | "plugin"): void {
  invalidatePingResult({ kind: "slot", slotId: slotName });
}

function providerOptionLabel(providerId: string): string {
  return PROVIDERS.find((item) => item.id === providerId)?.name ?? providerId;
}

function modelOptionsForProvider(
  presets: PresetSummary[],
  providerId: string,
): string[] {
  return [
    ...new Set(
      presets
        .filter((preset) => preset.enabled && preset.provider === providerId)
        .map((preset) => preset.model),
    ),
  ];
}

function defaultModelForProvider(
  presets: PresetSummary[],
  providerId: string,
): string {
  return modelOptionsForProvider(presets, providerId)[0] ?? "";
}

function findReusableCustomPreset(
  expected: Pick<CustomPreset, "provider" | "model" | "baseUrl" | "protocol">,
): CustomPreset | undefined {
  return getCustomPresets().find(
    (preset) =>
      preset.provider === expected.provider &&
      preset.model === expected.model &&
      (preset.baseUrl ?? "") === (expected.baseUrl ?? "") &&
      (preset.protocol ?? "") === (expected.protocol ?? ""),
  );
}

function upsertTransientPreset(input: Omit<CustomPreset, "id">): string {
  const existing = findReusableCustomPreset(input);
  if (existing) return existing.id;

  const nextPreset: CustomPreset = {
    ...input,
    id: `custom_${uid()}`,
  };
  setCustomPresets([...getCustomPresets(), nextPreset]);
  return nextPreset.id;
}

/**
 * Provider picker + API key form. Reused for both the story slot (narrator)
 * and the plugin slot. Parent owns the state so tests / ping results stay
 * independent per slot.
 */
function ProviderForm({
  state,
  onChange,
  onBeforePing,
  presets,
  slotName,
}: {
  state: ProviderFormState;
  onChange: (next: ProviderFormState) => void;
  /**
   * Called right before Ping fires — wizard uses this to persist the form
   * into providerKeys + custom presets + slot bindings so the server can
   * resolve `slot-<slotName>` correctly.
   */
  onBeforePing: () => Promise<void>;
  presets: PresetSummary[];
  slotName: "story" | "plugin";
}) {
  const { t } = useTranslation();
  const isCustom = state.selected === CUSTOM_PROVIDER_ID;
  const provider =
    PROVIDERS.find((p) => p.id === state.selected) ?? PROVIDERS[0];
  const modelOptions = modelOptionsForProvider(presets, state.selected);
  const modelListId = `onboarding-models-${slotName}`;

  const handleProviderSelect = (providerId: string) => {
    const existing = getProviderKeys();
    clearCachedPing(slotName);
    onChange({
      selected: providerId,
      apiKey:
        providerId === CUSTOM_PROVIDER_ID ? "" : (existing[providerId] ?? ""),
      keyVisible: false,
      builtInModel:
        providerId === CUSTOM_PROVIDER_ID
          ? state.builtInModel
          : defaultModelForProvider(presets, providerId),
      customBaseUrl:
        providerId === CUSTOM_PROVIDER_ID ? state.customBaseUrl : "",
      customModel: providerId === CUSTOM_PROVIDER_ID ? state.customModel : "",
      customProviderName:
        providerId === CUSTOM_PROVIDER_ID ? state.customProviderName : "",
    });
  };

  const updateField = <K extends keyof ProviderFormState>(
    key: K,
    value: ProviderFormState[K],
  ) => {
    clearCachedPing(slotName);
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="space-y-4">
      {/* Provider quick-select */}
      <div className="space-y-2">
        <Label className="ui-eyebrow text-[10px]">
          {t("onboarding.selectProvider", "Provider")}
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderSelect(p.id)}
              className={`rounded-[var(--radius-control)] px-3 py-2 text-xs font-medium border text-left transition-colors ${
                state.selected === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              {p.name}
            </button>
          ))}
          <button
            onClick={() => handleProviderSelect(CUSTOM_PROVIDER_ID)}
            className={`col-span-2 rounded-[var(--radius-control)] px-3 py-2 text-xs font-medium border text-left transition-colors ${
              isCustom
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40"
            }`}
          >
            {t("onboarding.customProvider", "Custom (OpenAI Compatible)")}
          </button>
        </div>
      </div>

      {!isCustom && (
        <div className="space-y-1.5">
          <Label className="ui-eyebrow text-[10px]">
            {t("onboarding.modelId", "Model ID")}
          </Label>
          <input
            type="text"
            list={modelOptions.length > 0 ? modelListId : undefined}
            placeholder="deepseek-chat / gpt-4o / claude-sonnet-4-20250514"
            value={state.builtInModel}
            onChange={(e) => updateField("builtInModel", e.target.value)}
            className="ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          {modelOptions.length > 0 && (
            <>
              <datalist id={modelListId}>
                {modelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <div className="text-[10px] text-muted-foreground">
                {t(
                  "onboarding.modelIdHint",
                  "Pick one of the detected models or type a model ID directly.",
                )}
              </div>
            </>
          )}
        </div>
      )}

      {isCustom && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label className="ui-eyebrow text-[10px]">Base URL</Label>
            <input
              type="text"
              placeholder="https://api.example.com/v1"
              value={state.customBaseUrl}
              onChange={(e) => updateField("customBaseUrl", e.target.value)}
              className="ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="ui-eyebrow text-[10px]">
                {t("onboarding.providerName", "Provider Name")}
              </Label>
              <input
                type="text"
                placeholder="my-provider"
                value={state.customProviderName}
                onChange={(e) =>
                  updateField("customProviderName", e.target.value)
                }
                className="ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="ui-eyebrow text-[10px]">
                {t("onboarding.modelId", "Model ID")}
              </Label>
              <input
                type="text"
                placeholder="gpt-4o / deepseek-chat"
                value={state.customModel}
                onChange={(e) => updateField("customModel", e.target.value)}
                className="ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="ui-eyebrow text-[10px]">
          {t("onboarding.apiKey", "API Key")}
        </Label>
        <div className="flex gap-1">
          <input
            type={state.keyVisible ? "text" : "password"}
            placeholder={isCustom ? "sk-..." : provider.placeholder}
            value={state.apiKey}
            onChange={(e) => updateField("apiKey", e.target.value)}
            className="ui-input-shell flex-1 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              onChange({ ...state, keyVisible: !state.keyVisible })
            }
            className="shrink-0"
          >
            {state.keyVisible ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
        {!isCustom && (
          <div className="text-[10px] text-muted-foreground font-mono">
            {provider.keyEnv}
          </div>
        )}
      </div>

      {state.apiKey.trim() && (
        <div className="flex items-center gap-2">
          <PingButton
            target={{ kind: "slot", slotId: slotName }}
            onBeforePing={onBeforePing}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Persist an API key + slot binding.
 *
 * For built-in providers we bind the slot to the exact provider/model pair.
 * Existing presets are reused; arbitrary model IDs synthesize a local preset.
 * For custom providers we register a local custom preset and point the
 * slot at that. Returns the resolved preset ID, or undefined if no match
 * could be found (e.g. built-in provider with no server-side preset yet).
 */
async function persistSlot(
  form: ProviderFormState,
  slotName: "story" | "plugin",
  presetCatalog: PresetSummary[],
): Promise<string | undefined> {
  const key = form.apiKey.trim();
  if (!key) return undefined;

  const isCustom = form.selected === CUSTOM_PROVIDER_ID;

  if (isCustom) {
    const provName = form.customProviderName.trim() || "custom";
    const existingKeys = getProviderKeys();
    setProviderKeys({ ...existingKeys, [provName]: key });

    const presetId = upsertTransientPreset({
      name: `${provName} — ${form.customModel || "default"}`,
      provider: provName,
      baseUrl: form.customBaseUrl.trim(),
      model: form.customModel.trim() || "default",
      protocol: "openai-chat-v1",
      apiKey: key,
    });
    const slots = getSlotConfig();
    setSlotConfig({ ...slots, [slotName]: { presetId } });
    return presetId;
  }

  const existingKeys = getProviderKeys();
  setProviderKeys({ ...existingKeys, [form.selected]: key });
  const desiredModel = form.builtInModel.trim();
  if (!desiredModel) return undefined;

  try {
    const presets =
      presetCatalog.length > 0 ? presetCatalog : await listPresets();
    const match = presets.find(
      (p) =>
        p.provider === form.selected && p.enabled && p.model === desiredModel,
    );
    if (match) {
      const slots = getSlotConfig();
      setSlotConfig({ ...slots, [slotName]: { presetId: match.id } });
      return match.id;
    }

    const presetId = upsertTransientPreset({
      name: `${providerOptionLabel(form.selected)} — ${desiredModel}`,
      provider: form.selected,
      model: desiredModel,
      baseUrl: "",
      apiKey: key,
    });
    const slots = getSlotConfig();
    setSlotConfig({ ...slots, [slotName]: { presetId } });
    return presetId;
  } catch {
    // Network hiccup — leave slot config untouched so the ping probe
    // surfaces the real problem to the user.
  }
  return undefined;
}

export function OnboardingWizard() {
  const [visible, setVisible] = useState(() => !isOnboarded());
  const { t } = useTranslation();
  const { locale, setLocale } = useLocalePreference();
  const [step, setStep] = useState(0);
  const [availablePresets, setAvailablePresets] = useState<PresetSummary[]>([]);

  const [storyForm, setStoryForm] = useState<ProviderFormState>(() =>
    emptyFormState(),
  );
  const [pluginMode, setPluginMode] = useState<"same" | "different">("same");
  const [pluginForm, setPluginForm] = useState<ProviderFormState>(() =>
    emptyFormState(),
  );

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

  useEffect(() => {
    if (
      storyForm.selected === CUSTOM_PROVIDER_ID ||
      storyForm.builtInModel.trim()
    )
      return;
    const nextModel = defaultModelForProvider(
      availablePresets,
      storyForm.selected,
    );
    if (!nextModel) return;
    setStoryForm((current) =>
      current.selected === CUSTOM_PROVIDER_ID || current.builtInModel.trim()
        ? current
        : { ...current, builtInModel: nextModel },
    );
  }, [availablePresets, storyForm.selected, storyForm.builtInModel]);

  useEffect(() => {
    if (
      pluginForm.selected === CUSTOM_PROVIDER_ID ||
      pluginForm.builtInModel.trim()
    )
      return;
    const nextModel = defaultModelForProvider(
      availablePresets,
      pluginForm.selected,
    );
    if (!nextModel) return;
    setPluginForm((current) =>
      current.selected === CUSTOM_PROVIDER_ID || current.builtInModel.trim()
        ? current
        : { ...current, builtInModel: nextModel },
    );
  }, [availablePresets, pluginForm.selected, pluginForm.builtInModel]);

  const dismiss = useCallback(() => {
    markOnboarded();
    setVisible(false);
  }, []);

  const handleNext = useCallback(() => {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const handleBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleBeforePingStory = useCallback(async () => {
    await persistSlot(storyForm, "story", availablePresets);
  }, [storyForm, availablePresets]);

  const handleBeforePingPlugin = useCallback(async () => {
    await persistSlot(pluginForm, "plugin", availablePresets);
  }, [pluginForm, availablePresets]);

  const handleContinueFromStory = useCallback(async () => {
    await persistSlot(storyForm, "story", availablePresets);
    // Default plugin slot to story when entering step 2 for the first time
    // so the "use same" radio reflects a real binding.
    const slots = getSlotConfig();
    if (!slots.plugin && slots.story) {
      setSlotConfig({ ...slots, plugin: slots.story });
    }
    setStep((s) => s + 1);
  }, [storyForm, availablePresets]);

  const handleContinueFromPlugin = useCallback(async () => {
    if (pluginMode === "different" && pluginForm.apiKey.trim()) {
      await persistSlot(pluginForm, "plugin", availablePresets);
    } else {
      const slots = getSlotConfig();
      if (slots.story) {
        setSlotConfig({ ...slots, plugin: slots.story });
      } else {
        const { plugin: _drop, ...rest } = slots;
        setSlotConfig(rest);
      }
    }
    setStep((s) => s + 1);
  }, [pluginForm, pluginMode, availablePresets]);

  if (!visible) return null;

  const storyCustom = storyForm.selected === CUSTOM_PROVIDER_ID;
  const storyProvider =
    PROVIDERS.find((p) => p.id === storyForm.selected) ?? PROVIDERS[0];
  const storyContinueDisabled =
    !storyForm.apiKey.trim() ||
    (storyCustom
      ? !storyForm.customBaseUrl.trim()
      : !storyForm.builtInModel.trim());

  const pluginCustom = pluginForm.selected === CUSTOM_PROVIDER_ID;
  const pluginContinueDisabled =
    pluginMode === "different" &&
    (!pluginForm.apiKey.trim() ||
      (pluginCustom
        ? !pluginForm.customBaseUrl.trim()
        : !pluginForm.builtInModel.trim()));

  const storySummary = storyCustom
    ? (storyForm.customProviderName.trim() || "custom") +
      (storyForm.customModel.trim() ? ` — ${storyForm.customModel.trim()}` : "")
    : `${storyProvider.name}${storyForm.builtInModel.trim() ? ` — ${storyForm.builtInModel.trim()}` : ""}`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm">
      {/* Always-on locale toggle — cheaper than forcing users back to Step 0. */}
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
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 sm:top-6 sm:right-6 text-muted-foreground hover:text-foreground transition-colors z-10"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="relative w-full max-w-md max-h-full flex flex-col min-h-0">
        {/* Step indicator */}
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

        <div className="ui-dialog-shell border border-border p-5 sm:p-8 overflow-y-auto min-h-0">
          {/* Step 0: Welcome */}
          {step === 0 && (
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
                onClick={handleNext}
                className="w-full text-xs uppercase tracking-widest"
              >
                {t("onboarding.getStarted", "Get Started")}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* Step 1: Narrator Model (covel.story) */}
          {step === 1 && (
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
                onBeforePing={handleBeforePingStory}
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
                  onClick={handleNext}
                  title={t(
                    "onboarding.skipTitle",
                    "You can configure this later in Settings.",
                  )}
                >
                  {t("onboarding.skip", "Skip for now")}
                </Button>
                <div className="flex-1" />
                <Button
                  onClick={handleContinueFromStory}
                  className="text-xs uppercase tracking-widest"
                  disabled={storyContinueDisabled}
                >
                  {t("onboarding.continue", "Continue")}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Plugin Model (covel.plugin) */}
          {step === 2 && (
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
                  onBeforePing={handleBeforePingPlugin}
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
                  onClick={handleBack}
                >
                  {t("onboarding.back", "Back")}
                </Button>
                <div className="flex-1" />
                <Button
                  onClick={handleContinueFromPlugin}
                  className="text-xs uppercase tracking-widest"
                  disabled={pluginContinueDisabled}
                >
                  {t("onboarding.continue", "Continue")}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Ready */}
          {step === 3 && (
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
                onClick={dismiss}
                className="w-full text-xs uppercase tracking-widest"
              >
                {t("onboarding.enter", "Enter Covel")}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
