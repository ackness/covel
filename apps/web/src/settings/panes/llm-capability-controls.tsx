import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label.js";
import {
  mergeCapability,
  type InputModality,
  type ModelCapabilityInfo,
  type ModelFeature,
  type OutputModality,
} from "@/services/api.js";

const ALL_INPUT_MODALITY_IDS: InputModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "file",
];
const ALL_OUTPUT_MODALITY_IDS: OutputModality[] = [
  "text",
  "image",
  "audio",
  "embedding",
];
const ALL_FEATURE_IDS: ModelFeature[] = [
  "function_calling",
  "structured_output",
  "streaming",
  "reasoning",
  "vision",
  "prompt_caching",
  "web_search",
  "computer_use",
];

const MODALITY_COLORS: Record<string, string> = {
  "in:image": "bg-violet-500/15 text-violet-600",
  "in:audio": "bg-amber-500/15 text-amber-600",
  "in:video": "bg-rose-500/15 text-rose-600",
  "in:file": "bg-slate-500/15 text-slate-600",
  "out:image": "bg-violet-500/15 text-violet-600",
  "out:audio": "bg-amber-500/15 text-amber-600",
  "out:embedding": "bg-teal-500/15 text-teal-600",
};

const MODALITY_LABEL_KEYS: Record<string, string> = {
  "in:image": "settings.modalInImage",
  "in:audio": "settings.modalInAudio",
  "in:video": "settings.modalInVideo",
  "in:file": "settings.modalInFile",
  "out:image": "settings.modalOutImage",
  "out:audio": "settings.modalOutAudio",
  "out:embedding": "settings.modalOutEmbedding",
};

const FEATURE_LABEL_KEYS: Record<string, string> = {
  function_calling: "settings.featFunctionCalling",
  structured_output: "settings.featStructuredOutput",
  streaming: "settings.featStreaming",
  reasoning: "settings.featReasoning",
  vision: "settings.featVision",
  prompt_caching: "settings.featPromptCaching",
  web_search: "settings.featWebSearch",
  computer_use: "settings.featComputerUse",
};

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

export function formatPrice(perMToken: number): string {
  if (perMToken < 0.01) return `$${perMToken.toFixed(3)}/M`;
  if (perMToken < 1) return `$${perMToken.toFixed(2)}/M`;
  return `$${perMToken.toFixed(1)}/M`;
}

export function CapabilityTags({
  capability: cap,
}: {
  capability: ModelCapabilityInfo;
}) {
  const { t } = useTranslation();
  const inputTags = cap.input
    .filter((m) => m !== "text")
    .map((m) => ({
      key: `in:${m}`,
      label: MODALITY_LABEL_KEYS[`in:${m}`]
        ? t(MODALITY_LABEL_KEYS[`in:${m}`])
        : m,
      color: MODALITY_COLORS[`in:${m}`],
    }))
    .filter((tag) => tag.color);
  const outputTags = cap.output
    .filter((m) => m !== "text")
    .map((m) => ({
      key: `out:${m}`,
      label: MODALITY_LABEL_KEYS[`out:${m}`]
        ? t(MODALITY_LABEL_KEYS[`out:${m}`])
        : m,
      color: MODALITY_COLORS[`out:${m}`],
    }))
    .filter((tag) => tag.color);
  const featureTags = (cap.features ?? [])
    .filter((f) => f !== "streaming")
    .map((f) => ({
      key: f,
      label: FEATURE_LABEL_KEYS[f] ? t(FEATURE_LABEL_KEYS[f]) : f,
    }));
  const hasLimits = cap.contextWindow || cap.maxOutputTokens;
  const hasPricing =
    cap.pricing && (cap.pricing.inputPerMToken || cap.pricing.perImage);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {inputTags.map((x) => (
          <span
            key={x.key}
            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${x.color}`}
          >
            {x.label}
          </span>
        ))}
        {outputTags.map((x) => (
          <span
            key={x.key}
            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${x.color}`}
          >
            {x.label}
          </span>
        ))}
        {featureTags.map((x) => (
          <span
            key={x.key}
            className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground"
          >
            {x.label}
          </span>
        ))}
      </div>
      {(hasLimits || hasPricing) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground font-mono">
          {cap.contextWindow ? (
            <span title={t("settings.contextWindow", "Context Window")}>
              {t("settings.contextWindowShort", "ctx")}:{" "}
              {formatTokenCount(cap.contextWindow)}
            </span>
          ) : null}
          {cap.maxOutputTokens ? (
            <span title={t("settings.maxOutputTokens", "Max Output Tokens")}>
              {t("settings.maxOutputTokensShort", "out")}:{" "}
              {formatTokenCount(cap.maxOutputTokens)}
            </span>
          ) : null}
          {cap.pricing?.inputPerMToken != null &&
          cap.pricing?.outputPerMToken != null ? (
            <span
              title={t(
                "settings.pricingInputOutputTitle",
                "Pricing (input/output per M tokens)",
              )}
            >
              {formatPrice(cap.pricing.inputPerMToken)} /{" "}
              {formatPrice(cap.pricing.outputPerMToken)}
            </span>
          ) : cap.pricing?.perImage != null ? (
            <span title={t("settings.pricePerImage", "Price per image")}>
              ${cap.pricing.perImage}/img
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CapabilityEditor({
  serverCap,
  override,
  onUpdate,
}: {
  serverCap: ModelCapabilityInfo | undefined;
  override: Partial<ModelCapabilityInfo> | undefined;
  onUpdate: (patch: Partial<ModelCapabilityInfo>) => void;
}) {
  const { t } = useTranslation();
  const effective = mergeCapability(serverCap, override);
  const currentInput = override?.input ?? serverCap?.input ?? ["text"];
  const currentOutput = override?.output ?? serverCap?.output ?? ["text"];
  const currentFeatures = override?.features ?? serverCap?.features ?? [];
  const toggle = <T extends string>(
    list: T[],
    item: T,
    field: "input" | "output" | "features",
  ) => {
    const next = list.includes(item)
      ? list.filter((m) => m !== item)
      : [...list, item];
    onUpdate({ [field]: next } as Partial<ModelCapabilityInfo>);
  };
  return (
    <div className="space-y-3 pt-1 border-t border-dashed border-border mt-2">
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("settings.inputModalities")}
        </Label>
        <div className="flex flex-wrap gap-1">
          {ALL_INPUT_MODALITY_IDS.map((id) => {
            const active = currentInput.includes(id);
            return (
              <button
                key={id}
                onClick={() =>
                  toggle(currentInput as InputModality[], id, "input")
                }
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {t(MODALITY_LABEL_KEYS[`in:${id}`] ?? `in:${id}`, {
                  defaultValue: id,
                })}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("settings.outputModalities")}
        </Label>
        <div className="flex flex-wrap gap-1">
          {ALL_OUTPUT_MODALITY_IDS.map((id) => {
            const active = currentOutput.includes(id);
            return (
              <button
                key={id}
                onClick={() =>
                  toggle(currentOutput as OutputModality[], id, "output")
                }
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {t(MODALITY_LABEL_KEYS[`out:${id}`] ?? `out:${id}`, {
                  defaultValue: id,
                })}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("settings.featureTags")}
        </Label>
        <div className="flex flex-wrap gap-1">
          {ALL_FEATURE_IDS.map((id) => {
            const active = currentFeatures.includes(id);
            return (
              <button
                key={id}
                onClick={() =>
                  toggle(currentFeatures as ModelFeature[], id, "features")
                }
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {t(FEATURE_LABEL_KEYS[id] ?? id, { defaultValue: id })}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("settings.contextWindowTokens", "Context Window (tokens)")}
          </Label>
          <input
            type="number"
            placeholder={effective?.contextWindow?.toString() ?? "e.g. 131072"}
            value={override?.contextWindow ?? ""}
            onChange={(e) =>
              onUpdate({
                contextWindow: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("settings.maxOutputTokens", "Max Output Tokens")}
          </Label>
          <input
            type="number"
            placeholder={effective?.maxOutputTokens?.toString() ?? "e.g. 8192"}
            value={override?.maxOutputTokens ?? ""}
            onChange={(e) =>
              onUpdate({
                maxOutputTokens: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("settings.pricing")}
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">
              {t("settings.pricingInput")}:
            </span>
            <input
              type="number"
              step="0.01"
              placeholder={
                effective?.pricing?.inputPerMToken?.toString() ?? "$/M"
              }
              value={override?.pricing?.inputPerMToken ?? ""}
              onChange={(e) =>
                onUpdate({
                  pricing: {
                    ...override?.pricing,
                    inputPerMToken: e.target.value
                      ? parseFloat(e.target.value)
                      : undefined,
                  },
                })
              }
              className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">
              {t("settings.pricingOutput")}:
            </span>
            <input
              type="number"
              step="0.01"
              placeholder={
                effective?.pricing?.outputPerMToken?.toString() ?? "$/M"
              }
              value={override?.pricing?.outputPerMToken ?? ""}
              onChange={(e) =>
                onUpdate({
                  pricing: {
                    ...override?.pricing,
                    outputPerMToken: e.target.value
                      ? parseFloat(e.target.value)
                      : undefined,
                  },
                })
              }
              className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
