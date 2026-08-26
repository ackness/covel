import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { getProviderKeys } from "@/services/api.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { CUSTOM_PROVIDER_ID, PROVIDERS } from "./constants.js";
import { clearCachedPing } from "./persistence.js";
import {
  defaultModelForProvider,
  modelOptionsForProvider,
} from "./provider-state.js";
import type { ProviderFormProps, ProviderFormState } from "./types.js";

/**
 * Provider picker + API key form. Reused for both the story slot (narrator)
 * and the plugin slot. Parent owns the state so tests / ping results stay
 * independent per slot.
 */
export function ProviderForm({
  state,
  onChange,
  onBeforePing,
  presets,
  slotName,
}: ProviderFormProps) {
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
      <div className="space-y-2">
        <Label className="ui-eyebrow text-[10px]">
          {t("onboarding.selectProvider", "Provider")}
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderSelect(p.id)}
              className={`rounded-(--radius-control) px-3 py-2 text-xs font-medium border text-left transition-colors ${
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
            className={`col-span-2 rounded-(--radius-control) px-3 py-2 text-xs font-medium border text-left transition-colors ${
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
            <Label className="ui-eyebrow text-[10px]">
              {t("onboarding.baseUrl", "Base URL")}
            </Label>
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
