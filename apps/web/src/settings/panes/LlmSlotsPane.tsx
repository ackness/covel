import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  Info,
  Loader2,
  Pencil,
  RotateCw,
  Zap,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import {
  fetchModelDbInfo,
  getCapabilityOverrides,
  getCustomPresets,
  getSlotConfig,
  mergeCapability,
  pingPreset,
  refreshModelDb,
  setCapabilityOverrides,
  setSlotConfig,
  type InputModality,
  type ModelCapabilityInfo,
  type ModelDbInfo,
  type ModelFeature,
  type OutputModality,
  type PingResult,
  type SlotConfigEntry,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { useSession } from "@/stores/session-store.js";

/**
 * Pane that surfaces the `[covel.<slot>]` sections from llm.toml and lets the
 * user override each slot's preset and capability metadata. Legacy (non-
 * configured) environments fall back to a fixed slot list.
 */
export function LlmSlotsPane() {
  const { t } = useTranslation();
  const { state } = useSession();
  const llm = state.llmConfig;
  const isConfigured = llm?.configured ?? false;

  const LEGACY_SLOTS = [
    "story",
    "plugin",
    "memory",
    "image",
    "fast",
    "balance",
    "default",
  ];

  const [slotConfig, setSlotConfigLocal] = useState<
    Record<string, SlotConfigEntry>
  >(() => getSlotConfig());
  const [capOverrides, setCapOverridesLocal] = useState<
    Record<string, Partial<ModelCapabilityInfo>>
  >(() => getCapabilityOverrides());
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<
    Record<string, PingResult & { testing?: boolean }>
  >({});
  const [modelDbInfo, setModelDbInfo] = useState<ModelDbInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchModelDbInfo().then(setModelDbInfo).catch(() => {});
  }, []);

  const customPresets = getCustomPresets();
  const allPresets = [
    ...state.presets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      isCustom: false,
    })),
    ...customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      isCustom: true,
    })),
  ];

  const configuredSlots = isConfigured ? Object.keys(llm!.slots) : [];
  const slots = isConfigured ? configuredSlots : LEGACY_SLOTS;

  const commitSlot = (next: Record<string, SlotConfigEntry>) => {
    setSlotConfigLocal(next);
    setSlotConfig(next);
  };

  const updateCapOverride = (
    slotId: string,
    patch: Partial<ModelCapabilityInfo>,
  ) => {
    const next = {
      ...capOverrides,
      [slotId]: { ...capOverrides[slotId], ...patch },
    };
    setCapOverridesLocal(next);
    setCapabilityOverrides(next);
  };

  const resetCapOverride = (slotId: string) => {
    const next = { ...capOverrides };
    delete next[slotId];
    setCapOverridesLocal(next);
    setCapabilityOverrides(next);
  };

  const getEffectiveCapability = (
    slotId: string,
  ): ModelCapabilityInfo | undefined => {
    const serverCap = isConfigured ? llm!.slots[slotId]?.capability : undefined;
    return mergeCapability(serverCap, capOverrides[slotId]);
  };

  const handlePing = async (presetId: string) => {
    setPingResults((prev) => ({
      ...prev,
      [presetId]: { ok: false, latencyMs: 0, testing: true },
    }));
    try {
      const result = await pingPreset(presetId);
      setPingResults((prev) => ({ ...prev, [presetId]: result }));
    } catch (err) {
      setPingResults((prev) => ({
        ...prev,
        [presetId]: {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "Network error",
        },
      }));
    }
  };

  const handleRefreshModelDb = async () => {
    setRefreshing(true);
    try {
      const result = await refreshModelDb();
      if (result.ok) {
        setModelDbInfo({
          available: true,
          count: result.count,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      {isConfigured && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="w-3 h-3" />
          <span>{t("settings.configuredByToml")}</span>
        </div>
      )}
      {slots.map((slotId) => {
        const selectedPresetId = slotConfig[slotId]?.presetId ?? "";
        const selectedPreset = allPresets.find(
          (p) => p.id === selectedPresetId,
        );
        const serverSlot = isConfigured ? llm!.slots[slotId] : null;
        const effectiveProvider =
          selectedPreset?.provider ?? serverSlot?.provider ?? "";
        const effectiveModel =
          selectedPreset?.model ?? serverSlot?.model ?? "";
        const effectiveProtocol = serverSlot?.protocol ?? "";
        const isRequired = !isConfigured && slotId === "default";
        const isFirst = isConfigured && slotId === configuredSlots[0];
        const pingId = `slot-${slotId}`;
        const ping = pingResults[pingId];
        const isTesting = ping?.testing;
        const effectiveCap = isConfigured
          ? getEffectiveCapability(slotId)
          : null;
        const hasCapOverride = isConfigured && !!capOverrides[slotId];
        const isEditing = editingSlot === slotId;

        return (
          <div key={slotId} className="border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{slotId}</span>
              <div className="flex items-center gap-1">
                {isRequired && (
                  <Badge variant="default" className="text-[10px]">
                    required
                  </Badge>
                )}
                {isFirst && (
                  <Badge variant="default" className="text-[10px]">
                    default
                  </Badge>
                )}
                {serverSlot?.fallback && (
                  <Badge variant="secondary" className="text-[10px]">
                    fallback: {serverSlot.fallback}
                  </Badge>
                )}
                {selectedPreset && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-amber-600 border-amber-400"
                  >
                    {t("settings.overrideApplied")}
                  </Badge>
                )}
              </div>
            </div>

            <select
              value={selectedPresetId}
              onChange={(e) => {
                const val = e.target.value;
                if (val) {
                  commitSlot({ ...slotConfig, [slotId]: { presetId: val } });
                } else {
                  const updated = { ...slotConfig };
                  delete updated[slotId];
                  commitSlot(updated);
                }
              }}
              className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">
                --{" "}
                {isConfigured
                  ? "Use base slot config"
                  : isRequired
                    ? t("settings.selectPreset")
                    : t("settings.noPresetFallback")}{" "}
                --
              </option>
              {state.presets.length > 0 && (
                <optgroup label="Built-in">
                  {state.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.provider}/{p.model})
                    </option>
                  ))}
                </optgroup>
              )}
              {customPresets.length > 0 && (
                <optgroup label="Custom">
                  {customPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.provider}/{p.model})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            <div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
              <span>Provider: {effectiveProvider || "—"}</span>
              <span>Model: {effectiveModel || "—"}</span>
              <span>
                {selectedPreset
                  ? selectedPreset.isCustom
                    ? "Preset: custom"
                    : "Preset: override"
                  : `Protocol: ${(effectiveProtocol || "").replace("-v1", "") || "—"}`}
              </span>
            </div>

            {isConfigured && effectiveCap && (
              <CapabilityTags capability={effectiveCap} />
            )}

            {isConfigured && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5"
                  onClick={() => setEditingSlot(isEditing ? null : slotId)}
                >
                  <Pencil className="w-3 h-3 mr-0.5" />
                  {isEditing
                    ? t("settings.collapseCapability")
                    : t("settings.editCapability")}
                </Button>
                {hasCapOverride && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-1.5 text-amber-600"
                    onClick={() => resetCapOverride(slotId)}
                  >
                    <RotateCw className="w-3 h-3 mr-0.5" />
                    {t("settings.resetOverride")}
                  </Button>
                )}
              </div>
            )}

            {isConfigured && isEditing && (
              <CapabilityEditor
                serverCap={serverSlot?.capability}
                override={capOverrides[slotId]}
                onUpdate={(patch) => updateCapOverride(slotId, patch)}
              />
            )}

            {isConfigured && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] px-2.5"
                  disabled={isTesting}
                  onClick={() => handlePing(pingId)}
                >
                  {isTesting ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <Zap className="w-3 h-3 mr-1" />
                  )}
                  Ping
                </Button>
                {ping && !isTesting && (
                  <span className="flex items-center gap-1 text-xs">
                    {ping.ok ? (
                      <>
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                        <span className="text-green-600 font-mono">
                          {ping.ttfbMs ?? ping.latencyMs}ms
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          TTFB
                        </span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3 h-3 text-destructive" />
                        <span
                          className="text-destructive truncate max-w-[200px]"
                          title={ping.error}
                        >
                          {ping.error?.slice(0, 40)}
                        </span>
                      </>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {isConfigured && (
        <div className="border border-dashed border-border p-3 space-y-2 mt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Database className="w-3 h-3" />
              {t("settings.modelDatabase")}
            </h4>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2"
              disabled={refreshing}
              onClick={handleRefreshModelDb}
            >
              {refreshing ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <RotateCw className="w-3 h-3 mr-1" />
              )}
              {t("settings.updateFromGitHub")}
            </Button>
          </div>
          {modelDbInfo?.available ? (
            <div className="text-[10px] text-muted-foreground space-y-0.5">
              <div>
                {t("settings.modelCount", { count: modelDbInfo.count })}
              </div>
              <div>
                {t("settings.updatedAt", {
                  date: modelDbInfo.updatedAt
                    ? new Date(modelDbInfo.updatedAt).toLocaleDateString()
                    : "?",
                })}
              </div>
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              {t("settings.dbUnavailable")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Capability helpers (ported from old dialog) ───────────────────

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

function formatTokenCount(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function formatPrice(perMToken: number): string {
  if (perMToken < 0.01) return `$${perMToken.toFixed(3)}/M`;
  if (perMToken < 1) return `$${perMToken.toFixed(2)}/M`;
  return `$${perMToken.toFixed(1)}/M`;
}

function CapabilityTags({ capability: cap }: { capability: ModelCapabilityInfo }) {
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
            <span title="Context Window">
              ctx: {formatTokenCount(cap.contextWindow)}
            </span>
          ) : null}
          {cap.maxOutputTokens ? (
            <span title="Max Output Tokens">
              out: {formatTokenCount(cap.maxOutputTokens)}
            </span>
          ) : null}
          {cap.pricing?.inputPerMToken != null &&
          cap.pricing?.outputPerMToken != null ? (
            <span title="Pricing (input/output per M tokens)">
              {formatPrice(cap.pricing.inputPerMToken)} /{" "}
              {formatPrice(cap.pricing.outputPerMToken)}
            </span>
          ) : cap.pricing?.perImage != null ? (
            <span title="Price per image">${cap.pricing.perImage}/img</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CapabilityEditor({
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
            Context Window (tokens)
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
            Max Output Tokens
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
