import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  X, ChevronRight, Sparkles, KeyRound, Rocket, Package,
  Eye, EyeOff, CheckCircle2, XCircle, Loader2, Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  getProviderKeys, setProviderKeys, pingPreset,
  addCustomPreset, uid, listPresets,
  getSlotConfig, setSlotConfig,
} from "@/services/api.js";
import type { PingResult } from "@/services/api.js";
import { useLocalePreference } from "@/hooks/useLocalePreference";

/**
 * Onboarding persistence uses a version number rather than a boolean so that
 * we can re-show the wizard after a tutorial has been materially updated.
 * Bump ONBOARDING_VERSION whenever the wizard flow changes in a way that
 * existing users should see again.
 */
const STORAGE_KEY = "covel:onboardedVersion";
const LEGACY_STORAGE_KEY = "covel:onboarded";
const ONBOARDING_VERSION = 2;
const CUSTOM_PROVIDER_ID = "__custom__";

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", placeholder: "sk-...", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "openai", name: "OpenAI", placeholder: "sk-...", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-...", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "dashscope", name: "DashScope", placeholder: "sk-...", keyEnv: "DASHSCOPE_API_KEY" },
] as const;

const TOTAL_STEPS = 4;

function isOnboarded(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed >= ONBOARDING_VERSION;
  }
  // Migrate legacy boolean flag: if the user already dismissed the v0 wizard,
  // do not force-show v1 unless the version actually bumped above 1.
  return localStorage.getItem(LEGACY_STORAGE_KEY) === "1" && ONBOARDING_VERSION <= 1;
}

function markOnboarded(): void {
  localStorage.setItem(STORAGE_KEY, String(ONBOARDING_VERSION));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

/** Force the onboarding wizard to appear again on next mount. Used by Settings "re-run tutorial". */
export function resetOnboarding(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

interface ProviderFormState {
  selected: string;
  apiKey: string;
  keyVisible: boolean;
  customBaseUrl: string;
  customModel: string;
  customProviderName: string;
  pingResult: (PingResult & { testing?: boolean }) | null;
}

function emptyFormState(initialProvider = "deepseek"): ProviderFormState {
  return {
    selected: initialProvider,
    apiKey: "",
    keyVisible: false,
    customBaseUrl: "",
    customModel: "",
    customProviderName: "",
    pingResult: null,
  };
}

/**
 * Provider picker + API key form. Reused for both the story slot (narrator)
 * and the plugin slot. Parent owns the state so tests / ping results stay
 * independent per slot.
 */
function ProviderForm({
  state,
  onChange,
  onPing,
}: {
  state: ProviderFormState;
  onChange: (next: ProviderFormState) => void;
  onPing: () => void;
}) {
  const { t } = useTranslation();
  const isCustom = state.selected === CUSTOM_PROVIDER_ID;
  const provider = PROVIDERS.find((p) => p.id === state.selected) ?? PROVIDERS[0];

  const handleProviderSelect = (providerId: string) => {
    const existing = getProviderKeys();
    onChange({
      selected: providerId,
      apiKey: providerId === CUSTOM_PROVIDER_ID ? "" : (existing[providerId] ?? ""),
      keyVisible: false,
      pingResult: null,
      customBaseUrl: providerId === CUSTOM_PROVIDER_ID ? state.customBaseUrl : "",
      customModel: providerId === CUSTOM_PROVIDER_ID ? state.customModel : "",
      customProviderName: providerId === CUSTOM_PROVIDER_ID ? state.customProviderName : "",
    });
  };

  const latencyDisplay = state.pingResult?.ttfbMs ?? state.pingResult?.latencyMs;

  return (
    <div className="space-y-4">
      {/* Provider quick-select */}
      <div className="space-y-2">
        <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
          {t("onboarding.selectProvider", "Provider")}
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderSelect(p.id)}
              className={`px-3 py-2 text-xs font-medium border text-left transition-colors ${
                state.selected === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {p.name}
            </button>
          ))}
          <button
            onClick={() => handleProviderSelect(CUSTOM_PROVIDER_ID)}
            className={`col-span-2 px-3 py-2 text-xs font-medium border text-left transition-colors ${
              isCustom
                ? "border-primary bg-primary/10 text-primary"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            {t("onboarding.customProvider", "Custom (OpenAI Compatible)")}
          </button>
        </div>
      </div>

      {isCustom && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
              Base URL
            </Label>
            <input
              type="text"
              placeholder="https://api.example.com/v1"
              value={state.customBaseUrl}
              onChange={(e) => onChange({ ...state, customBaseUrl: e.target.value, pingResult: null })}
              className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                {t("onboarding.providerName", "Provider Name")}
              </Label>
              <input
                type="text"
                placeholder="my-provider"
                value={state.customProviderName}
                onChange={(e) => onChange({ ...state, customProviderName: e.target.value, pingResult: null })}
                className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                {t("onboarding.modelId", "Model ID")}
              </Label>
              <input
                type="text"
                placeholder="gpt-4o / deepseek-chat"
                value={state.customModel}
                onChange={(e) => onChange({ ...state, customModel: e.target.value, pingResult: null })}
                className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
          {t("onboarding.apiKey", "API Key")}
        </Label>
        <div className="flex gap-1">
          <input
            type={state.keyVisible ? "text" : "password"}
            placeholder={isCustom ? "sk-..." : provider.placeholder}
            value={state.apiKey}
            onChange={(e) => onChange({ ...state, apiKey: e.target.value, pingResult: null })}
            className="flex-1 bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => onChange({ ...state, keyVisible: !state.keyVisible })}
            className="shrink-0 rounded-none"
          >
            {state.keyVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </Button>
        </div>
        {!isCustom && (
          <div className="text-[10px] text-zinc-500 font-mono">
            {provider.keyEnv}
          </div>
        )}
      </div>

      {state.apiKey.trim() && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-none text-[11px]"
            disabled={state.pingResult?.testing}
            onClick={onPing}
          >
            {state.pingResult?.testing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {t("onboarding.testConnection", "Test Connection")}
          </Button>
          {state.pingResult && !state.pingResult.testing && (
            <span className="flex items-center gap-1 text-xs">
              {state.pingResult.ok ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-green-500 font-mono">
                    {latencyDisplay ?? 0}ms
                    <span className="ml-1 text-[10px] text-green-500/70">TTFB</span>
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                  <span className="text-red-400 text-[11px] truncate max-w-[180px]">
                    {state.pingResult.error?.slice(0, 60) ?? "Failed"}
                  </span>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Persist an API key + slot binding.
 *
 * For built-in providers we look up the first enabled preset whose
 * `provider` field matches the user's pick and point the slot at it.
 * For custom providers we register a local custom preset and point the
 * slot at that. Returns the resolved preset ID, or undefined if no match
 * could be found (e.g. built-in provider with no server-side preset yet).
 */
async function persistSlot(
  form: ProviderFormState,
  slotName: "story" | "plugin",
): Promise<string | undefined> {
  const key = form.apiKey.trim();
  if (!key) return undefined;

  const isCustom = form.selected === CUSTOM_PROVIDER_ID;

  if (isCustom) {
    const provName = form.customProviderName.trim() || "custom";
    const existingKeys = getProviderKeys();
    setProviderKeys({ ...existingKeys, [provName]: key });

    const presetId = `custom_${uid()}`;
    addCustomPreset({
      id: presetId,
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

  try {
    const presets = await listPresets();
    const match = presets.find((p) => p.provider === form.selected && p.enabled);
    if (match) {
      const slots = getSlotConfig();
      setSlotConfig({ ...slots, [slotName]: { presetId: match.id } });
      return match.id;
    }
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

  const [storyForm, setStoryForm] = useState<ProviderFormState>(() => emptyFormState());
  const [pluginMode, setPluginMode] = useState<"same" | "different">("same");
  const [pluginForm, setPluginForm] = useState<ProviderFormState>(() => emptyFormState());

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

  const handlePingStory = useCallback(async () => {
    await persistSlot(storyForm, "story");
    setStoryForm((s) => ({ ...s, pingResult: { ok: false, latencyMs: 0, testing: true } }));
    try {
      const result = await pingPreset("slot-story");
      setStoryForm((s) => ({ ...s, pingResult: result }));
    } catch (err) {
      setStoryForm((s) => ({
        ...s,
        pingResult: {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "Network error",
        },
      }));
    }
  }, [storyForm]);

  const handlePingPlugin = useCallback(async () => {
    await persistSlot(pluginForm, "plugin");
    setPluginForm((p) => ({ ...p, pingResult: { ok: false, latencyMs: 0, testing: true } }));
    try {
      const result = await pingPreset("slot-plugin");
      setPluginForm((p) => ({ ...p, pingResult: result }));
    } catch (err) {
      setPluginForm((p) => ({
        ...p,
        pingResult: {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "Network error",
        },
      }));
    }
  }, [pluginForm]);

  const handleContinueFromStory = useCallback(async () => {
    await persistSlot(storyForm, "story");
    // Default plugin slot to story when entering step 2 for the first time
    // so the "use same" radio reflects a real binding.
    const slots = getSlotConfig();
    if (!slots.plugin && slots.story) {
      setSlotConfig({ ...slots, plugin: slots.story });
    }
    setStep((s) => s + 1);
  }, [storyForm]);

  const handleContinueFromPlugin = useCallback(async () => {
    if (pluginMode === "different" && pluginForm.apiKey.trim()) {
      await persistSlot(pluginForm, "plugin");
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
  }, [pluginForm, pluginMode]);

  if (!visible) return null;

  const storyCustom = storyForm.selected === CUSTOM_PROVIDER_ID;
  const storyProvider = PROVIDERS.find((p) => p.id === storyForm.selected) ?? PROVIDERS[0];
  const storyContinueDisabled =
    !storyForm.apiKey.trim() || (storyCustom && !storyForm.customBaseUrl.trim());

  const pluginCustom = pluginForm.selected === CUSTOM_PROVIDER_ID;
  const pluginContinueDisabled =
    pluginMode === "different" &&
    (!pluginForm.apiKey.trim() || (pluginCustom && !pluginForm.customBaseUrl.trim()));

  const storySummary = storyCustom
    ? (storyForm.customProviderName.trim() || "custom") +
      (storyForm.customModel.trim() ? ` — ${storyForm.customModel.trim()}` : "")
    : storyProvider.name;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <button
        onClick={dismiss}
        className="absolute top-6 right-6 text-zinc-500 hover:text-zinc-300 transition-colors"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="relative w-full max-w-md mx-4">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`h-1 transition-all duration-300 ${
                i === step
                  ? "w-8 bg-primary"
                  : i < step
                    ? "w-4 bg-primary/50"
                    : "w-4 bg-zinc-700"
              }`}
            />
          ))}
        </div>

        <div className="border border-zinc-800 bg-zinc-950 p-8">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <div className="space-y-8 text-center">
              <div className="space-y-4">
                <div className="flex items-center justify-center">
                  <div className="h-12 w-12 bg-primary flex items-center justify-center">
                    <div className="h-4 w-4 bg-zinc-950 rounded-full" />
                  </div>
                </div>
                <h1 className="text-2xl font-bold tracking-tight">
                  {t("onboarding.welcome", "Welcome to Covel")}
                </h1>
                <p className="text-sm text-zinc-400 leading-relaxed max-w-xs mx-auto">
                  {t(
                    "onboarding.tagline",
                    "AI-driven RPG engine. Craft interactive stories powered by large language models.",
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                  {t("onboarding.language", "Language")}
                </Label>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => setLocale("zh-CN")}
                    className={`px-4 py-2 text-xs font-medium border transition-colors ${
                      locale === "zh-CN"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {"\u4E2D\u6587"}
                  </button>
                  <button
                    onClick={() => setLocale("en-US")}
                    className={`px-4 py-2 text-xs font-medium border transition-colors ${
                      locale === "en-US"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    English
                  </button>
                </div>
              </div>

              <Button
                onClick={handleNext}
                className="w-full rounded-none text-xs uppercase tracking-widest"
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
                  <h2 className="text-sm font-semibold uppercase tracking-widest">
                    {t("onboarding.narratorModel", "Narrator Model")}
                  </h2>
                  <code className="text-[10px] text-zinc-500 font-mono">covel.story</code>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {t(
                    "onboarding.narratorModelDesc",
                    "The core model that drives the main story. Pick a provider and paste your key.",
                  )}
                </p>
              </div>

              <ProviderForm state={storyForm} onChange={setStoryForm} onPing={handlePingStory} />

              <div className="flex items-center gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none text-xs text-zinc-500"
                  onClick={handleNext}
                >
                  {t("onboarding.skip", "Skip for now")}
                </Button>
                <div className="flex-1" />
                <Button
                  onClick={handleContinueFromStory}
                  className="rounded-none text-xs uppercase tracking-widest"
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
                  <h2 className="text-sm font-semibold uppercase tracking-widest">
                    {t("onboarding.pluginModel", "Plugin Model")}
                  </h2>
                  <code className="text-[10px] text-zinc-500 font-mono">covel.plugin</code>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {t(
                    "onboarding.pluginModelDesc",
                    "Plugins (character tracker, world generator, codex, …) can share the narrator model or use a cheaper one.",
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => setPluginMode("same")}
                  className={`w-full flex items-start gap-3 p-3 border text-left transition-colors ${
                    pluginMode === "same"
                      ? "border-primary bg-primary/10"
                      : "border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  <div
                    className={`mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0 ${
                      pluginMode === "same"
                        ? "border-primary bg-primary"
                        : "border-zinc-600"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium">
                      {t("onboarding.pluginSame", "Use same as narrator")}
                    </div>
                    <div className="text-[11px] text-zinc-500 font-mono truncate">
                      {storySummary}
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => setPluginMode("different")}
                  className={`w-full flex items-start gap-3 p-3 border text-left transition-colors ${
                    pluginMode === "different"
                      ? "border-primary bg-primary/10"
                      : "border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  <div
                    className={`mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0 ${
                      pluginMode === "different"
                        ? "border-primary bg-primary"
                        : "border-zinc-600"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium">
                      {t("onboarding.pluginDifferent", "Use a different model")}
                    </div>
                    <div className="text-[11px] text-zinc-500">
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
                  onPing={handlePingPlugin}
                />
              )}

              <div className="flex items-center gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none text-xs text-zinc-500"
                  onClick={handleBack}
                >
                  {t("onboarding.back", "Back")}
                </Button>
                <div className="flex-1" />
                <Button
                  onClick={handleContinueFromPlugin}
                  className="rounded-none text-xs uppercase tracking-widest"
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
                <p className="text-sm text-zinc-400 leading-relaxed max-w-xs mx-auto">
                  {t(
                    "onboarding.readyDesc",
                    "Select a world, then start your adventure. You can adjust settings anytime from the top bar.",
                  )}
                </p>
              </div>

              <div className="border border-zinc-800 p-4 text-left space-y-3">
                <div className="flex items-start gap-3">
                  <Globe className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-xs font-medium">
                      {t("onboarding.step1Label", "Pick a world")}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {t("onboarding.step1Desc", "Choose from built-in worlds or create your own.")}
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Sparkles className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-xs font-medium">
                      {t("onboarding.step2Label", "Start your adventure")}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {t("onboarding.step2Desc", "The AI narrator will build a story around you.")}
                    </div>
                  </div>
                </div>
              </div>

              <Button
                onClick={dismiss}
                className="w-full rounded-none text-xs uppercase tracking-widest"
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
