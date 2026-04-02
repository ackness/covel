import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyRound, Check, Settings2, Cpu, SlidersHorizontal, Plus, Trash2,
  Download, Upload, Eye, EyeOff, ChevronDown, Info,
  Loader2, Zap, XCircle, CheckCircle2,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { Label } from "@/components/ui/label.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import {
  getProviderKeys, setProviderKeys,
  getSlotConfig, setSlotConfig,
  getCustomPresets, setCustomPresets, addCustomPreset, removeCustomPreset,
  getParamOverrides, setParamOverrides,
  pingPreset,
  uid,
  type SlotConfigEntry, type CustomPreset, type ModelParameterOverrides, type PresetSummary,
  type PingResult,
} from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", placeholder: "sk-..." },
  { id: "dashscope", name: "DashScope (Qwen)", placeholder: "sk-..." },
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
] as const;

const MODEL_SLOTS = [
  { id: "heavy", label: "Heavy", labelZh: "主力模型", desc: "主叙事、复杂推理", required: true, optional: false },
  { id: "fast", label: "Fast", labelZh: "快速模型", desc: "插件默认、轻量判断", required: false, optional: false },
  { id: "balance", label: "Balance", labelZh: "均衡模型", desc: "裁判插件、复杂逻辑", required: false, optional: false },
  { id: "image", label: "Image", labelZh: "图像模型", desc: "图像生成（可选）", required: false, optional: true },
] as const;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { state } = useSession();
  const [saved, setSaved] = useState(false);

  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [slotConfig, setSlotConfigLocal] = useState<Record<string, SlotConfigEntry>>({});
  const [customPresets, setCustomPresetsLocal] = useState<CustomPreset[]>([]);
  const [paramOverrides, setParamOverridesLocal] = useState<Record<string, ModelParameterOverrides>>({});
  const [selectedOverrideSlot, setSelectedOverrideSlot] = useState("heavy");

  const [newPreset, setNewPreset] = useState<Omit<CustomPreset, "id">>({
    name: "", provider: "", baseUrl: "", model: "",
  });

  // Ping test state: keyed by presetId
  const [pingResults, setPingResults] = useState<Record<string, PingResult & { testing?: boolean }>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setKeys(getProviderKeys());
      setSlotConfigLocal(getSlotConfig());
      setCustomPresetsLocal(getCustomPresets());
      setParamOverridesLocal(getParamOverrides());
      setSaved(false);
      setVisibleKeys({});
      setPingResults({});
    }
  }, [open]);

  const handlePing = async (presetId: string) => {
    setPingResults((prev) => ({ ...prev, [presetId]: { ok: false, latencyMs: 0, testing: true } }));
    // Temporarily save keys so the ping request uses the latest values
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

  const activeProviders = new Set<string>();
  for (const slot of Object.values(slotConfig)) {
    const preset = allPresets.find((p) => p.id === slot.presetId);
    if (preset) activeProviders.add(preset.provider);
  }

  const handleSave = () => {
    const cleanedKeys: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) cleanedKeys[k] = v.trim();
    }
    setProviderKeys(cleanedKeys);
    setSlotConfig(slotConfig);
    setCustomPresets(customPresets);
    setParamOverrides(paramOverrides);
    setSaved(true);
    setTimeout(() => onOpenChange(false), 600);
  };

  const handleAddCustomPreset = () => {
    if (!newPreset.name || !newPreset.provider || !newPreset.model) return;
    const preset: CustomPreset = { ...newPreset, id: `custom_${uid()}` };
    const updated = [...customPresets, preset];
    setCustomPresetsLocal(updated);
    setNewPreset({ name: "", provider: "", baseUrl: "", model: "" });
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
    const blob = new Blob([JSON.stringify(customPresets, null, 2)], { type: "application/json" });
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
        const imported = JSON.parse(reader.result as string) as CustomPreset[];
        if (!Array.isArray(imported)) return;
        const valid = imported
          .filter((p) => p.id && p.name && p.provider && p.model)
          .map((p) => ({
            ...p,
            name: typeof p.name === "string" ? p.name.slice(0, 100) : "",
            baseUrl:
              typeof p.baseUrl === "string" &&
              (p.baseUrl.startsWith("http://") || p.baseUrl.startsWith("https://"))
                ? p.baseUrl
                : "",
          }));
        setCustomPresetsLocal([...customPresets, ...valid]);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm uppercase tracking-widest">
            <Settings2 className="w-4 h-4" />
            {t("nav.settings", "Settings")}
          </DialogTitle>
          <DialogDescription>
            {/* 配置模型插槽、API 密钥和高级参数。所有数据仅存储在浏览器本地。 */}
            Configure model slots, API keys, and advanced parameters. All data is stored locally.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="slots" className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="slots" className="text-xs">
              <Cpu className="w-3 h-3 mr-1" />
              {/* 模型配置 */}
              Slots
            </TabsTrigger>
            <TabsTrigger value="keys" className="text-xs">
              <KeyRound className="w-3 h-3 mr-1" />
              {/* 密钥管理 */}
              Keys
            </TabsTrigger>
            <TabsTrigger value="advanced" className="text-xs">
              <SlidersHorizontal className="w-3 h-3 mr-1" />
              {/* 高级参数 */}
              Advanced
            </TabsTrigger>
            <TabsTrigger value="presets" className="text-xs">
              <Plus className="w-3 h-3 mr-1" />
              {/* 自定义预设 */}
              Presets
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-2 pr-1">
            {/* Tab 1: Model Slots */}
            <TabsContent value="slots" className="space-y-3 mt-0">
              {MODEL_SLOTS.map((slot) => {
                const selectedPresetId = slotConfig[slot.id]?.presetId ?? "";
                const selectedPreset = allPresets.find((p) => p.id === selectedPresetId);
                const isFallback = !selectedPresetId && slot.id !== "heavy";
                return (
                  <div key={slot.id} className="border border-border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{slot.labelZh}</span>
                        <span className="text-xs text-muted-foreground">({slot.label})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {slot.required && <Badge variant="default" className="text-[10px]">required</Badge>}
                        {slot.optional && <Badge variant="outline" className="text-[10px]">optional</Badge>}
                        {isFallback && (
                          <Badge variant="secondary" className="text-[10px]">
                            fallback: heavy
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{slot.desc}</p>
                    <select
                      value={selectedPresetId}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val) {
                          setSlotConfigLocal({ ...slotConfig, [slot.id]: { presetId: val } });
                        } else {
                          const updated = { ...slotConfig };
                          delete updated[slot.id];
                          setSlotConfigLocal(updated);
                        }
                      }}
                      className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">-- {slot.required ? "请选择预设" : "未配置（回退到 Heavy）"} --</option>
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

            {/* Tab 2: API Keys */}
            <TabsContent value="keys" className="space-y-3 mt-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="w-3 h-3" />
                <span>密钥仅存储在浏览器 localStorage 中，不会发送至服务器存储。</span>
              </div>
              {PROVIDERS.map((provider) => {
                const inUse = activeProviders.has(provider.id);
                const hasKey = !!(keys[provider.id]?.trim());
                const visible = visibleKeys[provider.id] ?? false;
                // Find presets that use this provider (for test buttons)
                const providerPresets = allPresets.filter((p) => p.provider === provider.id);

                return (
                  <div key={provider.id} className="border border-border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`key-${provider.id}`} className="text-xs flex items-center gap-2">
                        {provider.name}
                        {hasKey ? (
                          <Badge variant="default" className="text-[10px]">已配置</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">未配置</Badge>
                        )}
                        {inUse && <Badge variant="secondary" className="text-[10px]">使用中</Badge>}
                      </Label>
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

                    {/* Test buttons for each preset under this provider */}
                    {hasKey && providerPresets.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">连通测试</span>
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
                                测试
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

            {/* Tab 3: Advanced Parameters */}
            <TabsContent value="advanced" className="space-y-3 mt-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="w-3 h-3" />
                <span>留空则使用模型提供商默认值。</span>
                {/* Leave empty to use provider defaults */}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">选择插槽 (Select Slot)</Label>
                <select
                  value={selectedOverrideSlot}
                  onChange={(e) => setSelectedOverrideSlot(e.target.value)}
                  className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                >
                  {MODEL_SLOTS.map((slot) => (
                    <option key={slot.id} value={slot.id}>{slot.labelZh} ({slot.label})</option>
                  ))}
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

            {/* Tab 4: Custom Presets */}
            <TabsContent value="presets" className="space-y-3 mt-0">
              {customPresets.length > 0 && (
                <div className="space-y-2">
                  {customPresets.map((preset) => (
                    <div key={preset.id} className="flex items-center justify-between border border-border px-3 py-2 text-xs">
                      <div>
                        <span className="font-medium">{preset.name}</span>
                        <span className="text-muted-foreground ml-2">{preset.provider}/{preset.model}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleRemoveCustomPreset(preset.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {customPresets.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  暂无自定义预设 {/* No custom presets yet */}
                </p>
              )}

              <div className="border border-dashed border-border p-3 space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  添加预设 {/* Add Preset */}
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    placeholder="Name"
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
                    placeholder="Base URL"
                    value={newPreset.baseUrl}
                    onChange={(e) => setNewPreset({ ...newPreset, baseUrl: e.target.value })}
                    className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    placeholder="Model ID"
                    value={newPreset.model}
                    onChange={(e) => setNewPreset({ ...newPreset, model: e.target.value })}
                    className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddCustomPreset}
                  disabled={!newPreset.name || !newPreset.provider || !newPreset.model}
                  className="w-full text-xs"
                >
                  <Plus className="w-3 h-3" />
                  添加 {/* Add */}
                </Button>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleExportPresets} className="flex-1 text-xs">
                  <Download className="w-3 h-3" />
                  导出 {/* Export */}
                </Button>
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="flex-1 text-xs">
                  <Upload className="w-3 h-3" />
                  导入 {/* Import */}
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
          </div>
        </Tabs>

        <Button onClick={handleSave} className="w-full rounded-none uppercase tracking-widest text-xs mt-2">
          {saved ? (
            <span className="flex items-center gap-2"><Check className="w-3.5 h-3.5" /> Saved</span>
          ) : (
            t("common.save", "Save")
          )}
        </Button>
      </DialogContent>
    </Dialog>
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
