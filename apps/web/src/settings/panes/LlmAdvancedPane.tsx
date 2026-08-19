import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
  getParamOverrides,
  getProviderProfiles,
  getSlotConfig,
  flattenProviderProfiles,
  lookupModelCapabilityDetails,
  setParamOverrides,
  slotBindingId,
  type ModelParameterOverrides,
  type ReasoningEffortProfile,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useSession } from "@/stores/session-store.js";
import { ReasoningEffortCard } from "./llm-reasoning-effort-card.js";
import { pruneInvalidReasoningEffortOverride } from "./llm-reasoning-effort.js";

const DEFAULT_FALLBACK_SLOTS = [
  "story",
  "plugin",
  "memory",
  "image",
  "fast",
  "balance",
  "default",
];

type NumericParameter = Exclude<
  keyof ModelParameterOverrides,
  "maxOutputTokens" | "reasoningEffort"
>;

interface ParameterDefinition {
  field: NumericParameter;
  labelKey: string;
  fallbackLabel: string;
  descriptionKey: string;
  fallbackDescription: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
}

const PARAMETER_DEFINITIONS: readonly ParameterDefinition[] = [
  {
    field: "temperature",
    labelKey: "settings.temperature",
    fallbackLabel: "Temperature",
    descriptionKey: "settings.temperatureHint",
    fallbackDescription: "Higher values make responses more varied.",
    defaultValue: 1,
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    field: "topP",
    labelKey: "settings.topP",
    fallbackLabel: "Top P",
    descriptionKey: "settings.topPHint",
    fallbackDescription: "Limits sampling to the most likely token set.",
    defaultValue: 1,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    field: "frequencyPenalty",
    labelKey: "settings.frequencyPenalty",
    fallbackLabel: "Frequency penalty",
    descriptionKey: "settings.frequencyPenaltyHint",
    fallbackDescription: "Reduces repeated words and phrases.",
    defaultValue: 0,
    min: -2,
    max: 2,
    step: 0.1,
  },
  {
    field: "presencePenalty",
    labelKey: "settings.presencePenalty",
    fallbackLabel: "Presence penalty",
    descriptionKey: "settings.presencePenaltyHint",
    fallbackDescription: "Encourages the model to introduce new topics.",
    defaultValue: 0,
    min: -2,
    max: 2,
    step: 0.1,
  },
];

export function effectiveParameterValue(
  override: number | undefined,
  defaultValue: number,
): number {
  return override ?? defaultValue;
}

export function parseNumericParameterOverride(
  rawValue: string,
  min: number,
  max: number,
): number | undefined {
  if (!rawValue.trim()) return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

export function LlmAdvancedPane() {
  const { t } = useTranslation();
  const { state } = useSession();
  const llm = state.llmConfig;
  const isConfigured = llm?.configured ?? false;
  const configuredSlots = isConfigured ? Object.keys(llm!.slots) : [];
  const slots = isConfigured ? configuredSlots : DEFAULT_FALLBACK_SLOTS;

  const [paramOverrides, setParamOverridesLocal] = useState<
    Record<string, ModelParameterOverrides>
  >(() => getParamOverrides());
  const [selectedSlot, setSelectedSlot] = useState<string>(
    slots[0] ?? "default",
  );

  const current = paramOverrides[selectedSlot] ?? {};
  const serverSlot = llm?.slots[selectedSlot];
  const localModels = useMemo(
    () => flattenProviderProfiles(getProviderProfiles()),
    [],
  );
  const slotConfig = useMemo(() => getSlotConfig(), []);
  const boundModelId = slotBindingId(slotConfig[selectedSlot]);
  const boundModel = [...state.presets, ...localModels].find(
    (preset) => preset.id === boundModelId,
  );
  const effectiveTarget = {
    provider: boundModel?.provider ?? serverSlot?.provider ?? "",
    model: boundModel?.model ?? serverSlot?.model ?? "",
    protocol: boundModel?.protocol ?? serverSlot?.protocol,
  };
  const [reasoningProfile, setReasoningProfile] = useState<
    ReasoningEffortProfile | null | undefined
  >(undefined);

  useEffect(() => {
    let active = true;
    if (!effectiveTarget.model) {
      setReasoningProfile(null);
      return () => {
        active = false;
      };
    }
    setReasoningProfile(undefined);
    lookupModelCapabilityDetails(
      effectiveTarget.model,
      effectiveTarget.provider,
      effectiveTarget.protocol,
    )
      .then((result) => {
        if (active) setReasoningProfile(result.reasoning);
      })
      .catch(() => {
        if (active) setReasoningProfile(null);
      });
    return () => {
      active = false;
    };
  }, [
    effectiveTarget.model,
    effectiveTarget.provider,
    effectiveTarget.protocol,
  ]);
  const overrideCount = Object.values(current).filter(
    (value) => value !== undefined,
  ).length;

  const commit = (next: Record<string, ModelParameterOverrides>) => {
    setParamOverridesLocal(next);
    setParamOverrides(next);
  };

  const setField = <K extends keyof ModelParameterOverrides>(
    field: K,
    value: ModelParameterOverrides[K] | undefined,
  ) => {
    const nextSlot = { ...current };
    if (value === undefined) delete nextSlot[field];
    else nextSlot[field] = value;

    const next = { ...paramOverrides };
    if (Object.keys(nextSlot).length === 0) delete next[selectedSlot];
    else next[selectedSlot] = nextSlot;
    commit(next);
  };

  useEffect(() => {
    const next = pruneInvalidReasoningEffortOverride(
      paramOverrides,
      selectedSlot,
      reasoningProfile,
    );
    if (next !== paramOverrides) commit(next);
  }, [reasoningProfile, selectedSlot, current.reasoningEffort]);

  const resetSlot = () => {
    const next = { ...paramOverrides };
    delete next[selectedSlot];
    commit(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="leading-relaxed">{t("settings.advancedDesc")}</span>
      </div>

      <div className="border border-border bg-background p-3">
        <div className="flex items-end justify-between gap-3">
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              {t("settings.selectSlot")}
            </span>
            <select
              value={selectedSlot}
              onChange={(event) => setSelectedSlot(event.target.value)}
              className="w-full border border-border bg-background px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-primary"
            >
              {slots.map((slot) => (
                <option key={slot} value={slot}>
                  {slot}
                </option>
              ))}
            </select>
          </label>
          <Badge variant={overrideCount > 0 ? "default" : "outline"}>
            {overrideCount > 0
              ? t("settings.overrideCount", {
                  count: overrideCount,
                  defaultValue: "{{count}} overrides",
                })
              : t("settings.usingDefaults", "Using defaults")}
          </Badge>
        </div>
        {(effectiveTarget.provider || effectiveTarget.model) && (
          <div className="mt-2 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
            <span>{effectiveTarget.provider}</span>
            <span className="font-mono">{effectiveTarget.model}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {PARAMETER_DEFINITIONS.map((definition) => (
          <ParameterCard
            key={definition.field}
            definition={definition}
            override={current[definition.field]}
            onChange={(value) => setField(definition.field, value)}
          />
        ))}
        <ReasoningEffortCard
          profile={reasoningProfile}
          override={current.reasoningEffort}
          onChange={(value) => setField("reasoningEffort", value)}
        />
        <MaxOutputTokensCard
          override={current.maxOutputTokens}
          modelLimit={serverSlot?.capability?.maxOutputTokens}
          onChange={(value) => setField("maxOutputTokens", value)}
        />
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={resetSlot}
        disabled={overrideCount === 0}
        className="w-full text-xs"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t("settings.resetToDefaults", "Reset to defaults")}
      </Button>
    </div>
  );
}

function ParameterCard({
  definition,
  override,
  onChange,
}: {
  definition: ParameterDefinition;
  override: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const effective = effectiveParameterValue(override, definition.defaultValue);
  const decimals = definition.step < 0.1 ? 2 : definition.step < 1 ? 1 : 0;

  return (
    <div className="border border-border p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            {t(definition.labelKey, definition.fallbackLabel)}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {t(definition.descriptionKey, definition.fallbackDescription)}
          </p>
        </div>
        {override !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("settings.useDefault", "Use default")}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ValueCell
          label={t("settings.defaultValue", "Default")}
          value={definition.defaultValue.toFixed(decimals)}
        />
        <ValueCell
          label={t("settings.currentValue", "Current")}
          value={effective.toFixed(decimals)}
          active={override !== undefined}
        />
      </div>

      <div className="flex items-center gap-3">
        <input
          aria-label={t(definition.labelKey, definition.fallbackLabel)}
          type="range"
          min={definition.min}
          max={definition.max}
          step={definition.step}
          value={effective}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <input
          type="number"
          min={definition.min}
          max={definition.max}
          step={definition.step}
          value={override ?? effective}
          onChange={(event) => {
            onChange(
              parseNumericParameterOverride(
                event.target.value,
                definition.min,
                definition.max,
              ),
            );
          }}
          className="w-20 border border-border bg-background px-2 py-1.5 text-right font-mono text-xs tabular-nums outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex justify-between font-mono text-[9px] text-muted-foreground/70">
        <span>{definition.min}</span>
        <span>{definition.max}</span>
      </div>
    </div>
  );
}

function MaxOutputTokensCard({
  override,
  modelLimit,
  onChange,
}: {
  override: number | undefined;
  modelLimit?: number;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border border-border p-3 space-y-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t("settings.maxOutputTokens", "Max output tokens")}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {t(
              "settings.maxOutputTokensHint",
              "Caps one response. Leave unset to use the provider default.",
            )}
          </p>
        </div>
        {override !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("settings.useDefault", "Use default")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ValueCell
          label={t("settings.defaultValue", "Default")}
          value={t("settings.providerDefault", "Provider default")}
        />
        <ValueCell
          label={t("settings.currentValue", "Current")}
          value={
            override?.toLocaleString() ??
            t("settings.providerDefault", "Provider default")
          }
          active={override !== undefined}
        />
      </div>
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          max={modelLimit}
          step={1}
          placeholder={t("settings.numberPlaceholder", "e.g. 4096")}
          value={override ?? ""}
          onChange={(event) => {
            if (!event.target.value) {
              onChange(undefined);
              return;
            }
            const value = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(value) && value > 0) onChange(value);
          }}
          className="min-w-0 flex-1 border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary"
        />
        {modelLimit && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t("settings.modelOutputLimit", {
              value: modelLimit.toLocaleString(),
              defaultValue: "Model limit: {{value}}",
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function ValueCell({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <div
      className={
        active
          ? "border border-primary/40 bg-primary/5 px-2 py-1.5"
          : "border border-border/60 bg-muted/20 px-2 py-1.5"
      }
    >
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}
