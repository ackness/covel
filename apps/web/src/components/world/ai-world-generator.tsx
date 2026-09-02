import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorldExperienceMode,
  WorldPackageContentKind,
} from "@covel/shared";
import { Bot, Sparkles, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import type { GenerateWorldEvent, WorldRecord } from "@/services/api.js";
import * as api from "@/services/api.js";
import {
  generatedWorldSaveTargetForStorageMode,
  getDataService,
  getStorageMode,
  storageModeForServerStorage,
  type StorageMode,
} from "@/services/data-service.js";
import { WorldCreationOptions } from "./world-creation-options.js";
import {
  WorldGenerationStatus,
  type WorldGenerationPhase,
} from "./world-generation-status.js";

interface AiWorldGeneratorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorldCreated: (world: WorldRecord) => void;
}

const DEFAULT_CONTENT: readonly WorldPackageContentKind[] = [
  "characters",
  "lorebook",
  "rules",
  "memory",
  "opening-kit",
];

export function AiWorldGenerator({
  open,
  onOpenChange,
  onWorldCreated,
}: AiWorldGeneratorProps) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [experienceMode, setExperienceMode] =
    useState<WorldExperienceMode>("traditional-story");
  const [content, setContent] = useState<ReadonlySet<WorldPackageContentKind>>(
    () => new Set(DEFAULT_CONTENT),
  );
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [phase, setPhase] = useState<WorldGenerationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [serverStorageMode, setServerStorageMode] = useState<StorageMode>();
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const generationRef = useRef(0);

  const resetForm = useCallback(() => {
    setPrompt("");
    setExperienceMode("traditional-story");
    setContent(new Set(DEFAULT_CONTENT));
    setAdditionalInstructions("");
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
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
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    const generation = ++generationRef.current;
    setPhase("generating");
    setError(null);

    const handleEvent = (event: GenerateWorldEvent) => {
      if (generation !== generationRef.current) return;
      switch (event.type) {
        case "progress":
          setPhase(event.phase);
          break;
        case "done":
          abortRef.current = null;
          void (async () => {
            try {
              const world =
                getStorageMode() === "local"
                  ? await getDataService().saveGeneratedWorld(event.world)
                  : event.world;
              if (generation !== generationRef.current) return;
              setPhase("done");
              onWorldCreated(world);
              timerRef.current = setTimeout(() => {
                if (generation !== generationRef.current) return;
                timerRef.current = undefined;
                setPhase("idle");
                resetForm();
                onOpenChange(false);
              }, 900);
            } catch (err) {
              if (generation !== generationRef.current) return;
              setPhase("error");
              setError(err instanceof Error ? err.message : String(err));
            }
          })();
          break;
        case "error":
          abortRef.current = null;
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
        if (generation !== generationRef.current) return;
        abortRef.current = null;
        setPhase("error");
        setError(err.message);
      },
      undefined,
      {
        saveTarget: generatedWorldSaveTargetForStorageMode(serverStorageMode),
        brief: {
          experienceMode,
          content: [...content],
          ...(additionalInstructions.trim()
            ? { additionalInstructions: additionalInstructions.trim() }
            : {}),
        },
      },
    );
  }, [
    additionalInstructions,
    content,
    experienceMode,
    i18n.language,
    onOpenChange,
    onWorldCreated,
    prompt,
    resetForm,
    serverStorageMode,
  ]);

  const handleCancel = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
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
        resetForm();
      }
      onOpenChange(nextOpen);
    },
    [handleCancel, isWorking, onOpenChange, resetForm],
  );

  const toggleContent = useCallback((kind: WorldPackageContentKind) => {
    setContent((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const examplesRaw = t("world.aiPromptExamples", {
    returnObjects: true,
  }) as unknown;
  const examplePrompts: string[] = Array.isArray(examplesRaw)
    ? (examplesRaw as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[92dvh] w-[calc(100%-1rem)] overflow-hidden p-0 sm:max-w-5xl">
        <div className="flex items-center justify-between border-b border-border bg-muted/25 py-3 pr-14 pl-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-primary/12 text-primary">
              <Bot className="h-4 w-4" />
              <span className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-background bg-emerald-500" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {t("world.aiAgentName", "Worldsmith Agent")}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {isWorking
                  ? t("world.aiAgentWorking", "Working on your package")
                  : t("world.aiAgentReady", "Ready to plan")}
              </p>
            </div>
          </div>
          <span className="ui-eyebrow shrink-0 text-primary">
            {t("world.aiCreate", "AI generate")}
          </span>
        </div>

        <div className="max-h-[calc(92dvh-64px)] overflow-y-auto overscroll-contain px-5 pt-5 pb-24 sm:px-6 sm:pb-6">
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="font-display text-2xl leading-tight font-bold tracking-tight md:text-3xl">
              {t(
                "world.aiCreateTitle",
                "Build a playable world, not a blank shell.",
              )}
            </DialogTitle>
            <DialogDescription className="max-w-3xl text-sm leading-relaxed font-light text-muted-foreground">
              {t(
                "world.aiCreateDesc",
                "Give the agent a direction, then decide which authored content should ship with the world.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
            <div className="space-y-4">
              <div className="flex gap-3 rounded-(--radius-card) border border-primary/20 bg-primary/5 p-4">
                <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-xs leading-relaxed text-foreground/85">
                  {t(
                    "world.aiAgentGreeting",
                    "Tell me the core fantasy. I will turn it into a coherent setting, opening pressure, cast, rules, and reusable world knowledge.",
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor="world-prompt"
                    className="ui-eyebrow text-muted-foreground"
                  >
                    {t("world.aiPromptLabel", "Creative direction")}
                  </Label>
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {prompt.length}/4000
                  </span>
                </div>
                <textarea
                  id="world-prompt"
                  className="flex min-h-44 w-full resize-none rounded-(--radius-control) border border-border bg-background px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={t(
                    "world.aiPromptPlaceholderFull",
                    "A floating archipelago where every island entrusts its future to a different oracle…",
                  )}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  disabled={isWorking || phase === "done"}
                  maxLength={4000}
                />
              </div>

              {phase === "idle" && !prompt && examplePrompts.length > 0 && (
                <div className="space-y-2">
                  <span className="ui-eyebrow text-muted-foreground">
                    {t("world.aiExamples", "Try these")}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {examplePrompts.map((example, index) => (
                      <button
                        key={index}
                        type="button"
                        className="text-xs rounded-full border border-border/80 px-3 py-1.5 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/40 hover:text-foreground"
                        onClick={() => setPrompt(example)}
                      >
                        {example.length > 32
                          ? `${example.slice(0, 32)}…`
                          : example}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <WorldGenerationStatus phase={phase} error={error} t={t} />
            </div>

            <WorldCreationOptions
              t={t}
              experienceMode={experienceMode}
              content={content}
              additionalInstructions={additionalInstructions}
              disabled={isWorking || phase === "done"}
              onExperienceModeChange={setExperienceMode}
              onToggleContent={toggleContent}
              onAdditionalInstructionsChange={setAdditionalInstructions}
            />
          </div>

          <div className="sticky bottom-0 z-10 -mx-5 -mb-20 mt-5 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-5 pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:-mb-2 sm:px-6">
            <p className="hidden max-w-xl text-[11px] leading-relaxed text-muted-foreground sm:block">
              {t(
                "world.aiPortableHint",
                "Text package content remains available in server, database, and browser storage modes.",
              )}
            </p>
            <div className="ml-auto flex items-center gap-2">
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
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    {t("world.aiGenerate", "Create package")}
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
