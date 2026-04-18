import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  X, ChevronRight, Sparkles, KeyRound, Rocket,
  Eye, EyeOff, CheckCircle2, XCircle, Loader2, Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  getProviderKeys, setProviderKeys, pingPreset,
  addCustomPreset, uid,
} from "@/services/api.js";
import type { PingResult } from "@/services/api.js";

/**
 * Onboarding persistence uses a version number rather than a boolean so that
 * we can re-show the wizard after a tutorial has been materially updated.
 * Bump ONBOARDING_VERSION whenever the wizard flow changes in a way that
 * existing users should see again.
 */
const STORAGE_KEY = "covel:onboardedVersion";
const LEGACY_STORAGE_KEY = "covel:onboarded";
const ONBOARDING_VERSION = 1;
const CUSTOM_PROVIDER_ID = "__custom__";

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", placeholder: "sk-...", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "openai", name: "OpenAI", placeholder: "sk-...", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-...", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "dashscope", name: "DashScope", placeholder: "sk-...", keyEnv: "DASHSCOPE_API_KEY" },
] as const;

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
  // Clean up legacy flag to keep localStorage tidy.
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

/** Force the onboarding wizard to appear again on next mount. Used by Settings "re-run tutorial". */
export function resetOnboarding(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function OnboardingWizard() {
  const [visible, setVisible] = useState(() => !isOnboarded());
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState(0);

  // Provider key state
  const [selectedProvider, setSelectedProvider] = useState<string>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [pingResult, setPingResult] = useState<(PingResult & { testing?: boolean }) | null>(null);

  // Custom provider fields
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customProviderName, setCustomProviderName] = useState("");

  const isCustom = selectedProvider === CUSTOM_PROVIDER_ID;

  const dismiss = useCallback(() => {
    markOnboarded();
    setVisible(false);
  }, []);

  const handleNext = useCallback(() => {
    if (step < 2) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const handleSaveKey = useCallback(() => {
    if (!apiKey.trim()) return;

    if (isCustom) {
      // Register as a custom preset so the server knows about it
      const provName = customProviderName.trim() || "custom";
      const existing = getProviderKeys();
      setProviderKeys({ ...existing, [provName]: apiKey.trim() });
      addCustomPreset({
        id: `custom_${uid()}`,
        name: `${provName} — ${customModel || "default"}`,
        provider: provName,
        baseUrl: customBaseUrl.trim(),
        model: customModel.trim() || "default",
        protocol: "openai-chat-v1",
        apiKey: apiKey.trim(),
      });
    } else {
      const existing = getProviderKeys();
      setProviderKeys({ ...existing, [selectedProvider]: apiKey.trim() });
    }
  }, [selectedProvider, apiKey, isCustom, customBaseUrl, customModel, customProviderName]);

  const handlePing = useCallback(async () => {
    handleSaveKey();
    setPingResult({ ok: false, latencyMs: 0, testing: true });
    try {
      const result = await pingPreset(`slot-default`);
      setPingResult(result);
    } catch (err) {
      setPingResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }, [handleSaveKey]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setSelectedProvider(providerId);
    setApiKey("");
    setPingResult(null);
    setKeyVisible(false);
    if (providerId === CUSTOM_PROVIDER_ID) {
      setCustomBaseUrl("");
      setCustomModel("");
      setCustomProviderName("");
    } else {
      // Pre-fill if key already stored
      const existing = getProviderKeys();
      if (existing[providerId]) {
        setApiKey(existing[providerId]);
      }
    }
  }, []);

  const toggleLocale = useCallback(() => {
    const next = i18n.language === "zh-CN" ? "en-US" : "zh-CN";
    i18n.changeLanguage(next);
  }, [i18n]);

  if (!visible) return null;

  const provider = PROVIDERS.find((p) => p.id === selectedProvider) ?? PROVIDERS[0];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      {/* Dismiss button */}
      <button
        onClick={dismiss}
        className="absolute top-6 right-6 text-zinc-500 hover:text-zinc-300 transition-colors"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Card */}
      <div className="relative w-full max-w-md mx-4">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {[0, 1, 2].map((i) => (
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

              {/* Language selector */}
              <div className="space-y-2">
                <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                  {t("onboarding.language", "Language")}
                </Label>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => i18n.changeLanguage("zh-CN")}
                    className={`px-4 py-2 text-xs font-medium border transition-colors ${
                      i18n.language === "zh-CN"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {"\u4E2D\u6587"}
                  </button>
                  <button
                    onClick={() => i18n.changeLanguage("en-US")}
                    className={`px-4 py-2 text-xs font-medium border transition-colors ${
                      i18n.language === "en-US"
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

          {/* Step 1: Configure LLM Provider */}
          {step === 1 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold uppercase tracking-widest">
                    {t("onboarding.configureProvider", "Configure AI Provider")}
                  </h2>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {t(
                    "onboarding.providerDesc",
                    "Covel needs an LLM API key to generate stories. Pick a provider and paste your key.",
                  )}
                </p>
              </div>

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
                        selectedProvider === p.id
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

              {/* Custom provider fields */}
              {isCustom && (
                <div className="space-y-2">
                  <div className="space-y-1.5">
                    <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                      Base URL
                    </Label>
                    <input
                      type="text"
                      placeholder="https://api.example.com/v1"
                      value={customBaseUrl}
                      onChange={(e) => setCustomBaseUrl(e.target.value)}
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
                        value={customProviderName}
                        onChange={(e) => setCustomProviderName(e.target.value)}
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
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* API Key input */}
              <div className="space-y-2">
                <Label className="text-[10px] uppercase tracking-widest text-zinc-500">
                  {t("onboarding.apiKey", "API Key")}
                </Label>
                <div className="flex gap-1">
                  <input
                    type={keyVisible ? "text" : "password"}
                    placeholder={isCustom ? "sk-..." : provider.placeholder}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setPingResult(null);
                    }}
                    className="flex-1 bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setKeyVisible((v) => !v)}
                    className="shrink-0 rounded-none"
                  >
                    {keyVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </Button>
                </div>
                {!isCustom && (
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {provider.keyEnv}
                  </div>
                )}
              </div>

              {/* Test connection */}
              {apiKey.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-none text-[11px]"
                    disabled={pingResult?.testing}
                    onClick={handlePing}
                  >
                    {pingResult?.testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                    {t("onboarding.testConnection", "Test Connection")}
                  </Button>
                  {pingResult && !pingResult.testing && (
                    <span className="flex items-center gap-1 text-xs">
                      {pingResult.ok ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                          <span className="text-green-500 font-mono">
                            {pingResult.ttfbMs ?? pingResult.latencyMs}ms
                          </span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-3.5 h-3.5 text-red-400" />
                          <span className="text-red-400 text-[11px] truncate max-w-[180px]">
                            {pingResult.error?.slice(0, 40) ?? "Failed"}
                          </span>
                        </>
                      )}
                    </span>
                  )}
                </div>
              )}

              {/* Actions */}
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
                  onClick={() => {
                    handleSaveKey();
                    handleNext();
                  }}
                  className="rounded-none text-xs uppercase tracking-widest"
                  disabled={!apiKey.trim() || (isCustom && !customBaseUrl.trim())}
                >
                  {t("onboarding.continue", "Continue")}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Ready */}
          {step === 2 && (
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
