import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Loader2, AlertCircle, Check, Wand2 } from "lucide-react";
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
import {
  generatedWorldSaveTargetForStorageMode,
  getDataService,
  getStorageMode,
  storageModeForServerStorage,
  type StorageMode,
} from "@/services/data-service.js";

interface AiWorldGeneratorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorldCreated: (world: WorldRecord) => void;
}

type Phase = "idle" | "generating" | "validating" | "saving" | "done" | "error";

const PHASE_ORDER = ["generating", "validating", "saving"] as const;

export function AiWorldGenerator({
  open,
  onOpenChange,
  onWorldCreated,
}: AiWorldGeneratorProps) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [serverStorageMode, setServerStorageMode] = useState<StorageMode>();
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    void api
      .fetchServerHealth()
      .then((health) =>
        setServerStorageMode(
          storageModeForServerStorage(health.storage) ?? undefined,
        ),
      )
      .catch(() => setServerStorageMode(undefined));
  }, [open]);

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
          void (async () => {
            try {
              const world =
                getStorageMode() === "local"
                  ? await getDataService().saveGeneratedWorld(event.world)
                  : event.world;
              setPhase("done");
              onWorldCreated(world);
              timerRef.current = setTimeout(() => {
                setPhase("idle");
                setPrompt("");
                onOpenChange(false);
              }, 900);
            } catch (err) {
              setPhase("error");
              setError(err instanceof Error ? err.message : String(err));
            }
          })();
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
      undefined,
      {
        saveTarget: generatedWorldSaveTargetForStorageMode(serverStorageMode),
      },
    );
  }, [prompt, i18n.language, onWorldCreated, onOpenChange, serverStorageMode]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setError(null);
  }, []);

  const isWorking =
    phase === "generating" || phase === "validating" || phase === "saving";

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isWorking) return;
      if (!nextOpen) {
        handleCancel();
        setPrompt("");
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, handleCancel, isWorking],
  );

  const phaseLabel: Record<Phase, string> = {
    idle: "",
    generating: t("world.aiGenerating", "AI is shaping the world…"),
    validating: t("world.aiValidating", "Validating world data…"),
    saving: t("world.aiSaving", "Saving the world…"),
    done: t("world.aiDone", "World is ready!"),
    error: "",
  };

  const examplesRaw = t("world.aiPromptExamples", {
    returnObjects: true,
  }) as unknown;
  const examplePrompts: string[] = Array.isArray(examplesRaw)
    ? (examplesRaw as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
        {/* Editorial header strip */}
        <div
          aria-hidden="true"
          className="relative h-24 overflow-hidden border-b border-border"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 22%, var(--surface-panel-strong)) 0%, var(--surface-panel-strong) 70%)",
          }}
        >
          <div
            className="absolute -right-16 -top-12 h-44 w-44 rounded-full opacity-60"
            style={{
              background:
                "radial-gradient(circle, color-mix(in oklab, var(--color-primary) 70%, transparent) 0%, transparent 70%)",
            }}
          />
        </div>

        <div className="px-6 pb-6 pt-5">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              <span className="ui-eyebrow text-primary">
                {t("world.aiCreate", "AI generate")}
              </span>
            </div>
            <DialogTitle className="font-display text-2xl md:text-3xl font-bold tracking-tight leading-tight">
              {t("world.aiCreateTitle", "Describe the world you want.")}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground font-light leading-relaxed">
              {t(
                "world.aiCreateDesc",
                "One sentence is enough. The model writes the lore, schemas, and starting state.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-6">
            {/* Prompt input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="world-prompt"
                  className="ui-eyebrow text-muted-foreground"
                >
                  {t("world.aiPromptLabel", "World concept")}
                </Label>
                <span className="text-[10px] font-mono text-muted-foreground/70">
                  {prompt.length}/4000
                </span>
              </div>
              <textarea
                id="world-prompt"
                className="flex min-h-[140px] w-full rounded-[var(--radius-control)] border border-border bg-background px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none transition-colors"
                placeholder={t(
                  "world.aiPromptPlaceholderFull",
                  "e.g. A floating archipelago of stormbound airships where every island holds a single oracle...",
                )}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isWorking || phase === "done"}
                maxLength={4000}
              />
            </div>

            {/* Example prompts as chips */}
            {phase === "idle" && !prompt && examplePrompts.length > 0 && (
              <div className="space-y-2">
                <span className="ui-eyebrow text-muted-foreground">
                  {t("world.aiExamples", "Try these")}
                </span>
                <div className="flex flex-wrap gap-2">
                  {examplePrompts.map((example, i) => (
                    <button
                      key={i}
                      type="button"
                      className="text-xs px-3 py-1.5 rounded-full border border-border/80 hover:border-primary/40 hover:bg-muted/40 hover:text-foreground transition-colors text-muted-foreground"
                      onClick={() => setPrompt(example)}
                    >
                      {example.length > 32
                        ? example.slice(0, 32) + "…"
                        : example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Progress indicator */}
            {isWorking && (
              <div className="flex items-center gap-3 p-4 rounded-[var(--radius-control)] bg-muted/40 border border-border">
                <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{phaseLabel[phase]}</p>
                  <div className="flex gap-1.5 mt-2.5">
                    {PHASE_ORDER.map((step) => {
                      const idx = PHASE_ORDER.indexOf(step);
                      const cur = PHASE_ORDER.indexOf(
                        phase as (typeof PHASE_ORDER)[number],
                      );
                      return (
                        <div
                          key={step}
                          className={`h-1 flex-1 rounded-full transition-colors ${
                            idx === cur
                              ? "bg-primary animate-pulse"
                              : idx < cur
                                ? "bg-primary"
                                : "bg-muted-foreground/20"
                          }`}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Done */}
            {phase === "done" && (
              <div className="flex items-center gap-3 p-4 rounded-[var(--radius-control)] bg-emerald-500/10 border border-emerald-500/30">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                <p className="text-sm font-medium text-emerald-500">
                  {phaseLabel.done}
                </p>
              </div>
            )}

            {/* Error */}
            {phase === "error" && error && (
              <div className="flex items-start gap-3 p-4 rounded-[var(--radius-control)] bg-destructive/10 border border-destructive/30">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive">
                    {t("world.aiError", "Generation failed")}
                  </p>
                  <p className="text-xs text-destructive/80 mt-1 break-words leading-relaxed">
                    {error}
                  </p>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              {isWorking ? (
                <Button variant="outline" size="sm" onClick={handleCancel}>
                  {t("common.cancel", "Cancel")}
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
                      {t("world.aiRetry", "Retry")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={handleGenerate}
                    disabled={!prompt.trim() || phase === "done"}
                    className="px-5"
                  >
                    <Sparkles className="h-4 w-4 mr-1.5" />
                    {t("world.aiGenerate", "Generate world")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
