import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Loader2, Globe, AlertCircle, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import type { WorldRecord, GenerateWorldEvent } from "@/services/api.js";
import * as api from "@/services/api.js";

interface AiWorldGeneratorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorldCreated: (world: WorldRecord) => void;
}

type Phase = "idle" | "generating" | "validating" | "saving" | "done" | "error";

const EXAMPLE_PROMPTS = [
  "一个蒸汽朋克风格的空中城市，居民依靠飞艇在云层间的岛屿间贸易",
  "赛博朋克末世，人类与AI共存的地下城市，充满霓虹灯和黑客文化",
  "东方仙侠世界，修仙者在浮空山脉间修炼，妖魔横行",
  "后启示录废土，幸存者在辐射荒原中建立部落",
];

export function AiWorldGenerator({
  open,
  onOpenChange,
  onWorldCreated,
}: AiWorldGeneratorProps) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;

    setPhase("generating");
    setError(null);

    const handleEvent = (event: GenerateWorldEvent) => {
      switch (event.type) {
        case "progress":
          setPhase(event.phase);
          break;
        case "done":
          setPhase("done");
          onWorldCreated(event.world);
          // Auto-close after short delay
          timerRef.current = setTimeout(() => {
            setPhase("idle");
            setPrompt("");
            onOpenChange(false);
          }, 800);
          break;
        case "error":
          setPhase("error");
          setError(event.message);
          break;
      }
    };

    abortRef.current = api.generateWorld(
      prompt.trim(),
      i18n.language,
      handleEvent,
      (err) => {
        setPhase("error");
        setError(err.message);
      },
    );
  }, [prompt, i18n.language, onWorldCreated, onOpenChange]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setError(null);
  }, []);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isWorking) {
        // Don't close while generating
        return;
      }
      if (!nextOpen) {
        handleCancel();
        setPrompt("");
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, handleCancel],
  );

  const isWorking = phase === "generating" || phase === "validating" || phase === "saving";

  const phaseLabel: Record<Phase, string> = {
    idle: "",
    generating: t("world.aiGenerating", "AI 正在构建世界..."),
    validating: t("world.aiValidating", "验证世界数据..."),
    saving: t("world.aiSaving", "保存世界..."),
    done: t("world.aiDone", "世界创建完成！"),
    error: "",
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            {t("world.aiCreate", "AI 创建世界")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "world.aiCreateDesc",
              "描述你想要的世界概念，AI 将自动生成完整的世界观文档。",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Prompt input */}
          <div className="space-y-2">
            <Label htmlFor="world-prompt">
              {t("world.aiPromptLabel", "世界概念")}
            </Label>
            <textarea
              id="world-prompt"
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              placeholder={t(
                "world.aiPromptPlaceholder",
                "描述你想要的世界，例如：一个蒸汽朋克风格的空中城市...",
              )}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isWorking || phase === "done"}
              maxLength={4000}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{prompt.length}/4000</span>
            </div>
          </div>

          {/* Example prompts */}
          {phase === "idle" && !prompt && (
            <div className="space-y-2">
              <span className="text-xs text-muted-foreground">
                {t("world.aiExamples", "试试这些灵感：")}
              </span>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_PROMPTS.map((example, i) => (
                  <button
                    key={i}
                    type="button"
                    className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-muted/50 hover:bg-muted hover:border-primary/30 transition-colors text-left"
                    onClick={() => setPrompt(example)}
                  >
                    {example.length > 30
                      ? example.slice(0, 30) + "..."
                      : example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Progress indicator */}
          {isWorking && (
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50 border border-border">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <div className="flex-1">
                <p className="text-sm font-medium">{phaseLabel[phase]}</p>
                <div className="flex gap-1.5 mt-2">
                  {(["generating", "validating", "saving"] as const).map(
                    (step) => (
                      <div
                        key={step}
                        className={`h-1.5 flex-1 rounded-full transition-colors ${
                          phase === step
                            ? "bg-primary animate-pulse"
                            : (["generating", "validating", "saving"].indexOf(step) <
                              ["generating", "validating", "saving"].indexOf(phase))
                            ? "bg-primary"
                            : "bg-muted-foreground/20"
                        }`}
                      />
                    ),
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Done indicator */}
          {phase === "done" && (
            <div className="flex items-center gap-3 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20">
              <Check className="h-4 w-4 text-emerald-500" />
              <p className="text-sm font-medium text-emerald-600">
                {phaseLabel.done}
              </p>
            </div>
          )}

          {/* Error */}
          {phase === "error" && error && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-destructive/10 border border-destructive/20">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-destructive">
                  {t("world.aiError", "生成失败")}
                </p>
                <p className="text-xs text-destructive/80 mt-1 break-words">
                  {error}
                </p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            {isWorking ? (
              <Button variant="outline" size="sm" onClick={handleCancel}>
                {t("common.cancel")}
              </Button>
            ) : (
              <>
                {phase === "error" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPhase("idle");
                      setError(null);
                    }}
                  >
                    {t("world.aiRetry", "重试")}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={handleGenerate}
                  disabled={!prompt.trim() || phase === "done"}
                >
                  <Globe className="h-4 w-4 mr-1.5" />
                  {t("world.aiGenerate", "生成世界")}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
