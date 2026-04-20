import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyRound, Check, Settings2, Cpu, SlidersHorizontal, Plus, Trash2,
  Download, Upload, Eye, EyeOff, Info, Pencil, RotateCw, Database,
  Loader2, Zap, XCircle, CheckCircle2,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { DesktopSettingsTab, isDesktop } from "@/components/settings-desktop-tab.js";
import { Monitor } from "lucide-react";
import { Label } from "@/components/ui/label.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import {
  getProviderKeys, setProviderKeys,
  getSlotConfig, setSlotConfig,
  getCustomPresets, setCustomPresets, addCustomPreset, removeCustomPreset,
  getParamOverrides, setParamOverrides,
  getCapabilityOverrides, setCapabilityOverrides, mergeCapability,
  pingPreset, refreshModelDb, fetchModelDbInfo,
  uid,
  type SlotConfigEntry, type CustomPreset, type ModelParameterOverrides, type PresetSummary,
  type PingResult, type LlmConfigResponse, type ModelCapabilityInfo, type ModelDbInfo,
  type InputModality, type OutputModality, type ModelFeature,
} from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";
import { useLocalePreference, type SupportedLocale } from "@/hooks/useLocalePreference";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Fallback slot list when llm.toml is not configured (legacy mode). */
const LEGACY_SLOTS = ["story", "plugin", "memory", "image", "fast", "balance", "default"];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocalePreference();
  const { state } = useSession();
  const [saved, setSaved] = useState(false);

  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [slotConfig, setSlotConfigLocal] = useState<Record<string, SlotConfigEntry>>({});
  const [customPresets, setCustomPresetsLocal] = useState<CustomPreset[]>([]);
  const [paramOverrides, setParamOverridesLocal] = useState<Record<string, ModelParameterOverrides>>({});
  const [selectedOverrideSlot, setSelectedOverrideSlot] = useState("default");

  const [newPreset, setNewPreset] = useState<Omit<CustomPreset, "id">>({
    name: "", provider: "", baseUrl: "", model: "", protocol: "openai-chat-v1", apiKey: "",
  });

  const [pingResults, setPingResults] = useState<Record<string, PingResult & { testing?: boolean }>>({});
  const [capOverrides, setCapOverridesLocal] = useState<Record<string, Partial<ModelCapabilityInfo>>>({});
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [modelDbInfo, setModelDbInfo] = useState<ModelDbInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  const llm = state.llmConfig;
  const isConfigured = llm?.configured ?? false;

  useEffect(() => {
    if (open) {
      setKeys(getProviderKeys());
      setSlotConfigLocal(getSlotConfig());
      setCustomPresetsLocal(getCustomPresets());
      setParamOverridesLocal(getParamOverrides());
      setCapOverridesLocal(getCapabilityOverrides());
      setSaved(false);
      setVisibleKeys({});
      setPingResults({});
      setEditingSlot(null);
      // Load model DB info
      fetchModelDbInfo().then(setModelDbInfo).catch(() => {});
    }
  }, [open]);

  const handlePing = async (presetId: string) => {
    setPingResults((prev) => ({ ...prev, [presetId]: { ok: false, latencyMs: 0, testing: true } }));
    const cleanedKeys: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) cleanedKeys[k] = v.trim();
    }
    setProviderKeys(cleanedKeys);

    try {
      const result = await pingPreset(presetId);
      setPingResults((prev) => ({ ...prev, [presetId]: result }));
    } catch (err) {
      setPingResults((prev) => ({
        ...prev,
        [presetId]: { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : "Network error" },
      }));
    }
  };

  const allPresets: Array<{ id: string; name: string; provider: string; model: string; isCustom?: boolean }> = [
    ...state.presets.map((p) => ({ id: p.id, name: p.name, provider: p.provider, model: p.model })),
    ...customPresets.map((p) => ({ id: p.id, name: p.name, provider: p.provider, model: p.model, isCustom: true })),
  ];

  const handleSave = () => {
    const cleanedKeys: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) cleanedKeys[k] = v.trim();
    }
    setProviderKeys(cleanedKeys);
    setSlotConfig(slotConfig);
    setCustomPresets(customPresets);
    setParamOverrides(paramOverrides);
    setCapabilityOverrides(capOverrides);

    setSaved(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => onOpenChange(false), 600);
  };

  const handleRefreshModelDb = async () => {
    setRefreshing(true);
    try {
      const result = await refreshModelDb();
      if (result.ok) {
        setModelDbInfo({ available: true, count: result.count, updatedAt: new Date().toISOString() });
      }
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  };

  /** Get the effective capability for a slot (server data merged with user overrides). */
  const getEffectiveCapability = (slotId: string): ModelCapabilityInfo | undefined => {
    const serverCap = isConfigured ? llm!.slots[slotId]?.capability : undefined;
    return mergeCapability(serverCap, capOverrides[slotId]);
  };

  /** Update a single field in a slot's capability override. */
  const updateCapOverride = (slotId: string, patch: Partial<ModelCapabilityInfo>) => {
    setCapOverridesLocal((prev) => ({
      ...prev,
      [slotId]: { ...prev[slotId], ...patch },
    }));
  };

  /** Clear all overrides for a slot. */
  const resetCapOverride = (slotId: string) => {
    setCapOverridesLocal((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  };

  const handleAddCustomPreset = () => {
    if (!newPreset.name || !newPreset.provider || !newPreset.model) return;
    const preset: CustomPreset = { ...newPreset, id: `custom_${uid()}` };
    const updated = [...customPresets, preset];
    setCustomPresetsLocal(updated);
    if (preset.apiKey?.trim()) {
      setKeys((prev) => ({ ...prev, [preset.provider]: preset.apiKey! }));
    }
    setNewPreset({ name: "", provider: "", baseUrl: "", model: "", protocol: "openai-chat-v1", apiKey: "" });
  };

  const handleRemoveCustomPreset = (id: string) => {
    setCustomPresetsLocal(customPresets.filter((p) => p.id !== id));
    const updatedSlots = { ...slotConfig };
    for (const [slotId, entry] of Object.entries(updatedSlots)) {
      if (entry.presetId === id) delete updatedSlots[slotId];
    }
    setSlotConfigLocal(updatedSlots);
  };

  const handleExportPresets = () => {
    const exportSafe = customPresets.map(({ apiKey: _, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(exportSafe, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "covel-custom-presets.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportPresets = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result as string);
        if (!Array.isArray(imported) || imported.length > 200) return;
        const valid = imported
          .filter((p): p is Record<string, unknown> =>
            p != null &&
            typeof p === "object" &&
            typeof p.id === "string" && p.id.length > 0 && p.id.length <= 100 &&
            typeof p.name === "string" && p.name.length > 0 &&
            typeof p.provider === "string" && p.provider.length > 0 &&
            typeof p.model === "string" && p.model.length > 0
          )
          .map((p) => ({
            ...p,
            id: (p.id as string).slice(0, 100),
            name: (p.name as string).slice(0, 100),
            provider: (p.provider as string).slice(0, 100),
            model: (p.model as string).slice(0, 200),
            baseUrl:
              typeof p.baseUrl === "string" &&
              (p.baseUrl.startsWith("http://") || p.baseUrl.startsWith("https://"))
                ? p.baseUrl.slice(0, 500)
                : "",
          })) as CustomPreset[];
        const existingIds = new Set(customPresets.map((p) => p.id));
        const deduped = valid.filter((p) => !existingIds.has(p.id));
        setCustomPresetsLocal([...customPresets, ...deduped]);
      } catch {
        // invalid JSON
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const currentOverrides = paramOverrides[selectedOverrideSlot] ?? {};

  const setOverrideField = (field: keyof ModelParameterOverrides, value: number | undefined) => {
    setParamOverridesLocal({
      ...paramOverrides,
      [selectedOverrideSlot]: {
        ...currentOverrides,
        [field]: value,
      },
    });
  };

  const resetSlotOverrides = () => {
    const updated = { ...paramOverrides };
    delete updated[selectedOverrideSlot];
    setParamOverridesLocal(updated);
  };

  // Derive providers that need API keys
  const requiredProviders = isConfigured
    ? (llm!.providers ?? []).map((p) => ({
        id: p,
        name: p.charAt(0).toUpperCase() + p.slice(1),
        placeholder: "sk-...",
      }))
    : [
        { id: "deepseek", name: "DeepSeek", placeholder: "sk-..." },
        { id: "dashscope", name: "DashScope (Qwen)", placeholder: "sk-..." },
        { id: "openai", name: "OpenAI", placeholder: "sk-..." },
      ];

  // Active slots from server config
  const configuredSlots = isConfigured ? Object.keys(llm!.slots) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm uppercase tracking-widest">
            <Settings2 className="w-4 h-4" />
            {t("nav.settings")}
          </DialogTitle>
          <DialogDescription>
            {isConfigured
              ? t("settings.configuredDesc")
              : t("settings.unconfiguredDesc")
            }
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 px-0.5 py-1 border-b border-border">
          <Label htmlFor="locale-select" className="text-xs uppercase tracking-widest text-muted-foreground">
            {t("settings.language")}
          </Label>
          <select
            id="locale-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as SupportedLocale)}
            className="bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="zh-CN">{t("settings.langZh")}</option>
            <option value="en-US">{t("settings.langEn")}</option>
          </select>
        </div>

        {/* Storage mode is always "remote" (server-side SQLite). Toggle removed. */}

        <Tabs defaultValue={isConfigured ? "overview" : "slots"} className="flex-1 overflow-hidden flex flex-col">
          {(() => {
            const desktop = isDesktop();
            // Add one extra column when the Desktop tab is shown
            const baseCols = isConfigured ? 3 : 4;
            const gridCols = desktop ? baseCols + 1 : baseCols;
            return (
              <TabsList
                className="w-full grid"
                style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
              >
                {isConfigured ? (
                  <>
                    <TabsTrigger value="overview" className="text-xs">
                      <Cpu className="w-3 h-3 mr-1" />
                      Slots
                    </TabsTrigger>
                    <TabsTrigger value="keys" className="text-xs">
                      <KeyRound className="w-3 h-3 mr-1" />
                      Keys
                    </TabsTrigger>
                    <TabsTrigger value="advanced" className="text-xs">
                      <SlidersHorizontal className="w-3 h-3 mr-1" />
                      Advanced
                    </TabsTrigger>
                  </>
                ) : (
                  <>
                    <TabsTrigger value="slots" className="text-xs">
                      <Cpu className="w-3 h-3 mr-1" />
                      Slots
                    </TabsTrigger>
                    <TabsTrigger value="keys" className="text-xs">
                      <KeyRound className="w-3 h-3 mr-1" />
                      Keys
                    </TabsTrigger>
                    <TabsTrigger value="advanced" className="text-xs">
                      <SlidersHorizontal className="w-3 h-3 mr-1" />
                      Advanced
                    </TabsTrigger>
                    <TabsTrigger value="presets" className="text-xs">
                      <Plus className="w-3 h-3 mr-1" />
                      Presets
                    </TabsTrigger>
                  </>
                )}
                {desktop && (
                  <TabsTrigger value="desktop" className="text-xs">
                    <Monitor className="w-3 h-3 mr-1" />
                    Desktop
                  </TabsTrigger>
                )}
              </TabsList>
            );
          })()}

          <div className="flex-1 overflow-y-auto mt-2 pr-1">
            {/* ── Configured mode: Slot Overview (read-only from llm.toml) ── */}
            {isConfigured && (
              <TabsContent value="overview" className="space-y-3 mt-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Info className="w-3 h-3" />
                  <span>{t("settings.configuredByToml")}</span>
                </div>
                {configuredSlots.map((slotId) => {
                  const slot = llm!.slots[slotId];
                  const presetId = `slot-${slotId}`;
                  const ping = pingResults[presetId];
                  const isTesting = ping?.testing;
                  const cap = slot.capability;
                  const isFirst = slotId === configuredSlots[0];
                  return (
                    <div key={slotId} className="border border-border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {slotId}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {isFirst && <Badge variant="default" className="text-[10px]">default</Badge>}
                          {slot.fallback && (
                            <Badge variant="secondary" className="text-[10px]">
                              fallback: {slot.fallback}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
                        <span>Provider: {slot.provider}</span>
                        <span>Model: {slot.model}</span>
                        <span>Protocol: {(slot.protocol ?? "").replace("-v1", "")}</span>
                      </div>

                      {/* ── Capability Tags ── */}
                      {(() => {
                        const effective = getEffectiveCapability(slotId);
                        const hasOverride = !!capOverrides[slotId];
                        const isEditing = editingSlot === slotId;
                        return (
                          <>
                            {effective && <CapabilityTags capability={effective} />}
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-[10px] px-1.5"
                                onClick={() => setEditingSlot(isEditing ? null : slotId)}
                              >
                                <Pencil className="w-3 h-3 mr-0.5" />
                                {isEditing ? t("settings.collapseCapability") : t("settings.editCapability")}
                              </Button>
                              {hasOverride && (
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
                              {hasOverride && (
                                <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-400">{t("settings.overrideApplied")}</Badge>
                              )}
                            </div>
                            {isEditing && (
                              <CapabilityEditor
                                slotId={slotId}
                                serverCap={slot.capability}
                                override={capOverrides[slotId]}
                                onUpdate={(patch) => updateCapOverride(slotId, patch)}
                              />
                            )}
                          </>
                        );
                      })()}

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[11px] px-2.5"
                          disabled={isTesting}
                          onClick={() => handlePing(presetId)}
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
                                <span className="text-green-600 font-mono">{ping.ttfbMs ?? ping.latencyMs}ms</span>
                                <span className="text-[10px] text-muted-foreground">TTFB</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-3 h-3 text-destructive" />
                                <span className="text-destructive truncate max-w-[200px]" title={ping.error}>
                                  {ping.error?.slice(0, 40)}
                                </span>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* ── Model Database Info ── */}
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
                      <div>{t("settings.modelCount", { count: modelDbInfo.count })}</div>
                      <div>{t("settings.updatedAt", { date: modelDbInfo.updatedAt ? new Date(modelDbInfo.updatedAt).toLocaleDateString() : "?" })}</div>
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground">{t("settings.dbUnavailable")}</div>
                  )}
                </div>
              </TabsContent>
            )}

            {/* ── Legacy mode: Manual Slot Assignment ── */}
            {!isConfigured && (
              <TabsContent value="slots" className="space-y-3 mt-0">
                {LEGACY_SLOTS.map((slotId) => {
                  const selectedPresetId = slotConfig[slotId]?.presetId ?? "";
                  const selectedPreset = allPresets.find((p) => p.id === selectedPresetId);
                  const isRequired = slotId === "default";
                  const isFallback = !selectedPresetId && slotId !== "default";
                  return (
                    <div key={slotId} className="border border-border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{slotId}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {isRequired && <Badge variant="default" className="text-[10px]">required</Badge>}
                          {isFallback && (
                            <Badge variant="secondary" className="text-[10px]">
                              fallback: default
                            </Badge>
                          )}
                        </div>
                      </div>
                      <select
                        value={selectedPresetId}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            setSlotConfigLocal({ ...slotConfig, [slotId]: { presetId: val } });
                          } else {
                            const updated = { ...slotConfig };
                            delete updated[slotId];
                            setSlotConfigLocal(updated);
                          }
                        }}
                        className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">-- {isRequired ? t("settings.selectPreset") : t("settings.noPresetFallback")} --</option>
                        {state.presets.length > 0 && (
                          <optgroup label="Built-in">
                            {state.presets.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} ({p.provider}/{p.model})</option>
                            ))}
                          </optgroup>
                        )}
                        {customPresets.length > 0 && (
                          <optgroup label="Custom">
                            {customPresets.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} ({p.provider}/{p.model})</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      {selectedPreset && (
                        <div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
                          <span>Provider: {selectedPreset.provider}</span>
                          <span>Model: {selectedPreset.model}</span>
                          {selectedPreset.isCustom && <span className="text-amber-500">custom</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </TabsContent>
            )}

            {/* ── Keys Tab ── */}
            <TabsContent value="keys" className="space-y-3 mt-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="w-3 h-3" />
                <span>
                  {isConfigured
                    ? t("settings.keysConfiguredDesc")
                    : t("settings.keysLocalDesc")
                  }
                </span>
              </div>
              {requiredProviders.map((provider) => {
                const hasKey = !!(keys[provider.id]?.trim());
                const visible = visibleKeys[provider.id] ?? false;
                // Find presets using this provider for ping tests
                const providerPresets = allPresets.filter((p) => p.provider === provider.id);

                return (
                  <div key={provider.id} className="border border-border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`key-${provider.id}`} className="text-xs flex items-center gap-2">
                        {provider.name}
                        {hasKey ? (
                          <Badge variant="default" className="text-[10px]">{t("settings.keyConfigured")}</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">{t("settings.keyUnconfigured")}</Badge>
                        )}
                      </Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {provider.id.toUpperCase().replace(/-/g, "_")}_API_KEY
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <input
                        id={`key-${provider.id}`}
                        type={visible ? "text" : "password"}
                        placeholder={provider.placeholder}
                        value={keys[provider.id] ?? ""}
                        onChange={(e) => setKeys((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                        className="flex-1 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setVisibleKeys((prev) => ({ ...prev, [provider.id]: !visible }))}
                        className="shrink-0"
                      >
                        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </Button>
                    </div>

                    {/* Ping test for presets under this provider */}
                    {hasKey && providerPresets.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">{t("settings.pingTest")}</span>
                        {providerPresets.map((preset) => {
                          const ping = pingResults[preset.id];
                          const isTesting = ping?.testing;
                          return (
                            <div key={preset.id} className="flex items-center gap-2 text-xs">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px] px-2.5 shrink-0"
                                disabled={isTesting}
                                onClick={() => handlePing(preset.id)}
                              >
                                {isTesting ? (
                                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                ) : (
                                  <Zap className="w-3 h-3 mr-1" />
                                )}
                                Ping
                              </Button>
                              <span className="truncate text-muted-foreground">{preset.name}</span>
                              <span className="text-[10px] text-muted-foreground">({preset.model})</span>
                              {ping && !isTesting && (
                                <span className="flex items-center gap-1 ml-auto shrink-0">
                                  {ping.ok ? (
                                    <>
                                      <CheckCircle2 className="w-3 h-3 text-green-500" />
                                      <span className="text-green-600 font-mono">{ping.ttfbMs ?? ping.latencyMs}ms</span>
                                      <span className="text-[10px] text-muted-foreground">TTFB</span>
                                    </>
                                  ) : (
                                    <>
                                      <XCircle className="w-3 h-3 text-destructive" />
                                      <span className="text-destructive truncate max-w-[120px]" title={ping.error}>
                                        {ping.error?.slice(0, 30)}
                                      </span>
                                    </>
                                  )}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>

            {/* ── Advanced Parameters ── */}
            <TabsContent value="advanced" className="space-y-3 mt-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="w-3 h-3" />
                <span>{t("settings.advancedDesc")}</span>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("settings.selectSlot")}</Label>
                <select
                  value={selectedOverrideSlot}
                  onChange={(e) => setSelectedOverrideSlot(e.target.value)}
                  className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                >
                  {(isConfigured ? configuredSlots : LEGACY_SLOTS).map((slotId) => {
                    return (
                      <option key={slotId} value={slotId}>
                        {slotId}
                      </option>
                    );
                  })}
                </select>
              </div>

              <SliderField
                label="Temperature"
                value={currentOverrides.temperature}
                onChange={(v) => setOverrideField("temperature", v)}
                min={0} max={2} step={0.1}
              />
              <SliderField
                label="Top P"
                value={currentOverrides.topP}
                onChange={(v) => setOverrideField("topP", v)}
                min={0} max={1} step={0.05}
              />
              <div className="space-y-1.5">
                <Label className="text-xs">Max Output Tokens</Label>
                <input
                  type="number"
                  placeholder="e.g. 4096"
                  value={currentOverrides.maxOutputTokens ?? ""}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value, 10) : undefined;
                    setOverrideField("maxOutputTokens", val);
                  }}
                  className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              <SliderField
                label="Frequency Penalty"
                value={currentOverrides.frequencyPenalty}
                onChange={(v) => setOverrideField("frequencyPenalty", v)}
                min={-2} max={2} step={0.1}
              />
              <SliderField
                label="Presence Penalty"
                value={currentOverrides.presencePenalty}
                onChange={(v) => setOverrideField("presencePenalty", v)}
                min={-2} max={2} step={0.1}
              />

              <Button
                variant="outline"
                size="sm"
                onClick={resetSlotOverrides}
                className="w-full text-xs uppercase tracking-widest"
              >
                Reset to defaults
              </Button>
            </TabsContent>

            {/* ── Custom Presets (legacy mode only) ── */}
            {!isConfigured && (
              <TabsContent value="presets" className="space-y-3 mt-0">
                {customPresets.length > 0 && (
                  <div className="space-y-2">
                    {customPresets.map((preset) => (
                      <div key={preset.id} className="border border-border px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{preset.name}</span>
                            {preset.apiKey && <Badge variant="default" className="text-[10px]">{t("settings.hasApiKey")}</Badge>}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleRemoveCustomPreset(preset.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                        <div className="text-muted-foreground flex flex-wrap gap-x-3">
                          <span>{preset.provider}/{preset.model}</span>
                          {preset.protocol && <span>{preset.protocol}</span>}
                          {preset.baseUrl && <span className="truncate max-w-[200px]">{preset.baseUrl}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {customPresets.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    {t("settings.noCustomPresets")}
                  </p>
                )}

                <div className="border border-dashed border-border p-3 space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {t("settings.addPreset")}
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder={t("settings.namePlaceholder")}
                      value={newPreset.name}
                      onChange={(e) => setNewPreset({ ...newPreset, name: e.target.value })}
                      className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                      placeholder="Provider (e.g. openai)"
                      value={newPreset.provider}
                      onChange={(e) => setNewPreset({ ...newPreset, provider: e.target.value })}
                      className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                      placeholder="Model ID (e.g. deepseek-chat)"
                      value={newPreset.model}
                      onChange={(e) => setNewPreset({ ...newPreset, model: e.target.value })}
                      className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                    />
                    <select
                      value={newPreset.protocol ?? "openai-chat-v1"}
                      onChange={(e) => setNewPreset({ ...newPreset, protocol: e.target.value })}
                      className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="openai-chat-v1">OpenAI Chat (v1)</option>
                      <option value="openai-responses-v1">OpenAI Responses (v1)</option>
                      <option value="anthropic-messages-v1">Anthropic Messages (v1)</option>
                    </select>
                    <input
                      placeholder={t("settings.baseUrlPlaceholder")}
                      value={newPreset.baseUrl}
                      onChange={(e) => setNewPreset({ ...newPreset, baseUrl: e.target.value })}
                      className="col-span-2 bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                    />
                    <div className="col-span-2 flex gap-1">
                      <input
                        type={visibleKeys[`new_preset`] ? "text" : "password"}
                        placeholder="API Key (sk-...)"
                        value={newPreset.apiKey ?? ""}
                        onChange={(e) => setNewPreset({ ...newPreset, apiKey: e.target.value })}
                        className="flex-1 bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="shrink-0 h-7 w-7"
                        onClick={() => setVisibleKeys((prev) => ({ ...prev, new_preset: !prev.new_preset }))}
                      >
                        {visibleKeys[`new_preset`] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      </Button>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddCustomPreset}
                    disabled={!newPreset.name || !newPreset.provider || !newPreset.model}
                    className="w-full text-xs"
                  >
                    <Plus className="w-3 h-3" />
                    {t("settings.add")}
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleExportPresets} className="flex-1 text-xs">
                    <Download className="w-3 h-3" />
                    {t("settings.export")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="flex-1 text-xs">
                    <Upload className="w-3 h-3" />
                    {t("settings.import")}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={handleImportPresets}
                  />
                </div>
              </TabsContent>
            )}

            {/* ── Desktop tab (Electron only) ── */}
            {isDesktop() && (
              <TabsContent value="desktop" className="mt-0">
                <DesktopSettingsTab />
              </TabsContent>
            )}
          </div>
        </Tabs>

        <Button onClick={handleSave} className="w-full rounded-none uppercase tracking-widest text-xs mt-2">
          {saved ? (
            <span className="flex items-center gap-2"><Check className="w-3.5 h-3.5" /> Saved</span>
          ) : (
            t("common.save")
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ── Modality / Feature display labels ─────────────────────────────

const MODALITY_COLORS: Record<string, string> = {
  "in:text":       "bg-blue-500/15 text-blue-600",
  "in:image":      "bg-violet-500/15 text-violet-600",
  "in:audio":      "bg-amber-500/15 text-amber-600",
  "in:video":      "bg-rose-500/15 text-rose-600",
  "in:file":       "bg-slate-500/15 text-slate-600",
  "out:text":      "bg-blue-500/15 text-blue-600",
  "out:image":     "bg-violet-500/15 text-violet-600",
  "out:audio":     "bg-amber-500/15 text-amber-600",
  "out:embedding": "bg-teal-500/15 text-teal-600",
};

const MODALITY_LABEL_KEYS: Record<string, string> = {
  "in:text":       "settings.modalInText",
  "in:image":      "settings.modalInImage",
  "in:audio":      "settings.modalInAudio",
  "in:video":      "settings.modalInVideo",
  "in:file":       "settings.modalInFile",
  "out:text":      "settings.modalOutText",
  "out:image":     "settings.modalOutImage",
  "out:audio":     "settings.modalOutAudio",
  "out:embedding": "settings.modalOutEmbedding",
};

const FEATURE_LABEL_KEYS: Record<string, string> = {
  function_calling:  "settings.featFunctionCalling",
  structured_output: "settings.featStructuredOutput",
  streaming:         "settings.featStreaming",
  reasoning:         "settings.featReasoning",
  vision:            "settings.featVision",
  prompt_caching:    "settings.featPromptCaching",
  web_search:        "settings.featWebSearch",
  computer_use:      "settings.featComputerUse",
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function formatPrice(perMToken: number): string {
  if (perMToken < 0.01) return `$${perMToken.toFixed(3)}/M`;
  if (perMToken < 1) return `$${perMToken.toFixed(2)}/M`;
  return `$${perMToken.toFixed(1)}/M`;
}

// ── Capability Editor ─────────────────────────────────────────────

const ALL_INPUT_MODALITY_IDS: InputModality[] = ["text", "image", "audio", "video", "file"];
const ALL_OUTPUT_MODALITY_IDS: OutputModality[] = ["text", "image", "audio", "embedding"];
const ALL_FEATURE_IDS: ModelFeature[] = [
  "function_calling", "structured_output", "streaming", "reasoning",
  "vision", "prompt_caching", "web_search", "computer_use",
];

function CapabilityEditor({
  slotId,
  serverCap,
  override,
  onUpdate,
}: {
  slotId: string;
  serverCap: ModelCapabilityInfo | undefined;
  override: Partial<ModelCapabilityInfo> | undefined;
  onUpdate: (patch: Partial<ModelCapabilityInfo>) => void;
}) {
  const { t } = useTranslation();
  const effective = mergeCapability(serverCap, override);
  const currentInput = override?.input ?? serverCap?.input ?? ["text"];
  const currentOutput = override?.output ?? serverCap?.output ?? ["text"];
  const currentFeatures = override?.features ?? serverCap?.features ?? [];

  const toggleModality = <T extends string>(
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
      {/* Input Modalities */}
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
                onClick={() => toggleModality(currentInput as InputModality[], id, "input")}
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {t(MODALITY_LABEL_KEYS[`in:${id}`] ?? `in:${id}`, { defaultValue: id })}
              </button>
            );
          })}
        </div>
      </div>

      {/* Output Modalities */}
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
                onClick={() => toggleModality(currentOutput as OutputModality[], id, "output")}
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {t(MODALITY_LABEL_KEYS[`out:${id}`] ?? `out:${id}`, { defaultValue: id })}
              </button>
            );
          })}
        </div>
      </div>

      {/* Features */}
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
                onClick={() => toggleModality(currentFeatures as ModelFeature[], id, "features")}
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

      {/* Numeric fields */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Context Window (tokens)
          </Label>
          <input
            type="number"
            placeholder={effective?.contextWindow?.toString() ?? "e.g. 131072"}
            value={override?.contextWindow ?? ""}
            onChange={(e) => onUpdate({
              contextWindow: e.target.value ? parseInt(e.target.value, 10) : undefined,
            })}
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
            onChange={(e) => onUpdate({
              maxOutputTokens: e.target.value ? parseInt(e.target.value, 10) : undefined,
            })}
            className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("settings.pricing")}
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">{t("settings.pricingInput")}:</span>
            <input
              type="number"
              step="0.01"
              placeholder={effective?.pricing?.inputPerMToken?.toString() ?? "$/M"}
              value={override?.pricing?.inputPerMToken ?? ""}
              onChange={(e) => onUpdate({
                pricing: {
                  ...override?.pricing,
                  inputPerMToken: e.target.value ? parseFloat(e.target.value) : undefined,
                },
              })}
              className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">{t("settings.pricingOutput")}:</span>
            <input
              type="number"
              step="0.01"
              placeholder={effective?.pricing?.outputPerMToken?.toString() ?? "$/M"}
              value={override?.pricing?.outputPerMToken ?? ""}
              onChange={(e) => onUpdate({
                pricing: {
                  ...override?.pricing,
                  outputPerMToken: e.target.value ? parseFloat(e.target.value) : undefined,
                },
              })}
              className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CapabilityTags({ capability: cap }: { capability: ModelCapabilityInfo }) {
  const { t } = useTranslation();
  // Only show non-text modalities as tags (text is assumed)
  const inputTags = cap.input
    .filter((m) => m !== "text")
    .map((m) => ({ key: `in:${m}`, label: MODALITY_LABEL_KEYS[`in:${m}`] ? t(MODALITY_LABEL_KEYS[`in:${m}`]) : m, color: MODALITY_COLORS[`in:${m}`] }))
    .filter((tag) => tag.color);
  const outputTags = cap.output
    .filter((m) => m !== "text")
    .map((m) => ({ key: `out:${m}`, label: MODALITY_LABEL_KEYS[`out:${m}`] ? t(MODALITY_LABEL_KEYS[`out:${m}`]) : m, color: MODALITY_COLORS[`out:${m}`] }))
    .filter((tag) => tag.color);
  const featureTags = (cap.features ?? [])
    .filter((f) => f !== "streaming") // streaming is ubiquitous, skip
    .map((f) => ({ key: f, label: FEATURE_LABEL_KEYS[f] ? t(FEATURE_LABEL_KEYS[f]) : f }));

  const hasLimits = cap.contextWindow || cap.maxOutputTokens;
  const hasPricing = cap.pricing && (cap.pricing.inputPerMToken || cap.pricing.perImage);

  return (
    <div className="space-y-1.5">
      {/* Modality + Feature badges */}
      <div className="flex flex-wrap gap-1">
        {inputTags.map((t) => (
          <span key={t.key} className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${t.color}`}>
            {t.label}
          </span>
        ))}
        {outputTags.map((t) => (
          <span key={t.key} className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${t.color}`}>
            {t.label}
          </span>
        ))}
        {featureTags.map((t) => (
          <span key={t.key} className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground">
            {t.label}
          </span>
        ))}
      </div>

      {/* Token limits + Pricing in a compact row */}
      {(hasLimits || hasPricing) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground font-mono">
          {cap.contextWindow ? (
            <span title="Context Window">ctx: {formatTokenCount(cap.contextWindow)}</span>
          ) : null}
          {cap.maxOutputTokens ? (
            <span title="Max Output Tokens">out: {formatTokenCount(cap.maxOutputTokens)}</span>
          ) : null}
          {cap.pricing?.inputPerMToken != null && cap.pricing?.outputPerMToken != null ? (
            <span title="Pricing (input/output per M tokens)">
              {formatPrice(cap.pricing.inputPerMToken)} / {formatPrice(cap.pricing.outputPerMToken)}
            </span>
          ) : cap.pricing?.perImage != null ? (
            <span title="Price per image">${cap.pricing.perImage}/img</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SliderField({
  label, value, onChange, min, max, step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min: number;
  max: number;
  step: number;
}) {
  const displayValue = value ?? "";
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "") {
      onChange(undefined);
      return;
    }
    const num = parseFloat(raw);
    if (!isNaN(num)) {
      onChange(Math.min(max, Math.max(min, num)));
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-muted-foreground font-mono w-12 text-right">
          {value !== undefined ? value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0) : "--"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value ?? (min + max) / 2}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 h-1.5 appearance-none bg-muted rounded-full cursor-pointer accent-primary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={displayValue}
          onChange={handleInputChange}
          placeholder="--"
          className="w-16 bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono text-center"
        />
      </div>
    </div>
  );
}
