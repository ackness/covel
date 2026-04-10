import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Label } from "@/components/ui/label.js";
import { Toggle } from "@/components/ui/toggle.js";
import { Palette } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

const STYLE_OPTIONS = [
  "cinematic",
  "anime",
  "oil-painting",
  "watercolor",
  "pixel-art",
  "photoreal",
] as const;

type ImageStyle = (typeof STYLE_OPTIONS)[number];

interface ImageSettingsData {
  style?: ImageStyle;
  multiPanel?: boolean;
  includeText?: boolean;
  promptLanguage?: "auto" | "zh" | "en";
}

export function CoreImageSettingsBlock({ data, onSubmit }: BlockRendererProps) {
  const { t } = useTranslation();

  const settings = data as ImageSettingsData;
  const style = settings.style ?? "cinematic";
  const multiPanel = settings.multiPanel ?? false;
  const includeText = settings.includeText ?? false;
  const promptLanguage = settings.promptLanguage ?? "auto";

  function handleChange(patch: Partial<ImageSettingsData>) {
    const next = { ...settings, ...patch };
    onSubmit?.(JSON.stringify({ _eventType: "image.settings.updated", settings: next }));
  }

  const selectClass =
    "w-full bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary transition-all";

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Palette className="h-4 w-4" />
          {t("coreImage.settings.title", "插画生成设置")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Art style */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("coreImage.settings.style", "画面风格")}
          </Label>
          <select
            value={style}
            onChange={(e) => handleChange({ style: e.target.value as ImageStyle })}
            className={selectClass}
          >
            {STYLE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {t(`coreImage.style.${s}`, s)}
              </option>
            ))}
          </select>
        </div>

        {/* Multi-panel toggle */}
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("coreImage.settings.multiPanel", "多格组图")}
          </Label>
          <Toggle
            pressed={multiPanel}
            onPressedChange={(v) => handleChange({ multiPanel: v })}
            size="sm"
            className="h-6 px-2 text-[10px]"
          >
            {multiPanel ? "ON" : "OFF"}
          </Toggle>
        </div>

        {/* Include text toggle */}
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("coreImage.settings.includeText", "图中含文字")}
          </Label>
          <Toggle
            pressed={includeText}
            onPressedChange={(v) => handleChange({ includeText: v })}
            size="sm"
            className="h-6 px-2 text-[10px]"
          >
            {includeText ? "ON" : "OFF"}
          </Toggle>
        </div>

        {/* Prompt language */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("coreImage.settings.promptLanguage", "Prompt 语言")}
          </Label>
          <select
            value={promptLanguage}
            onChange={(e) =>
              handleChange({ promptLanguage: e.target.value as "auto" | "zh" | "en" })
            }
            className={selectClass}
          >
            <option value="auto">
              {t("coreImage.promptLang.auto", "自动（跟随语言设置）")}
            </option>
            <option value="zh">
              {t("coreImage.promptLang.zh", "中文（推荐 DashScope）")}
            </option>
            <option value="en">
              {t("coreImage.promptLang.en", "英文（推荐 GPT/Gemini）")}
            </option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}
