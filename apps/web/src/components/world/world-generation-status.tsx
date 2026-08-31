import type { TFunction } from "i18next";
import { AlertCircle, Check, Loader2 } from "lucide-react";

export type WorldGenerationPhase =
  "idle" | "generating" | "validating" | "saving" | "done" | "error";

interface WorldGenerationStatusProps {
  phase: WorldGenerationPhase;
  error: string | null;
  t: TFunction;
}

const PHASE_ORDER = ["generating", "validating", "saving"] as const;

export function WorldGenerationStatus({
  phase,
  error,
  t,
}: WorldGenerationStatusProps) {
  const isWorking = PHASE_ORDER.includes(phase as (typeof PHASE_ORDER)[number]);
  if (phase === "idle") return null;

  if (phase === "error") {
    if (!error) return null;
    return (
      <div className="flex items-start gap-3 rounded-(--radius-control) border border-destructive/30 bg-destructive/10 p-4">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">
            {t("world.aiError", "Generation failed")}
          </p>
          <p className="mt-1 text-xs leading-relaxed wrap-break-word text-destructive/80">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="flex items-center gap-3 rounded-(--radius-control) border border-emerald-500/30 bg-emerald-500/10 p-4">
        <Check className="h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-sm font-medium text-emerald-500">
          {t("world.aiDone", "World is ready!")}
        </p>
      </div>
    );
  }

  if (!isWorking) return null;
  const labels = {
    generating: t("world.aiStepAuthoring", "Authoring"),
    validating: t("world.aiStepReviewing", "Reviewing"),
    saving: t("world.aiStepPackaging", "Packaging"),
  };
  const currentIndex = PHASE_ORDER.indexOf(
    phase as (typeof PHASE_ORDER)[number],
  );

  return (
    <div
      role="status"
      className="rounded-(--radius-control) border border-border bg-muted/35 p-4"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <p className="text-sm font-medium">
          {phase === "generating"
            ? t("world.aiGenerating", "AI is shaping the world…")
            : phase === "validating"
              ? t("world.aiValidating", "Validating world data…")
              : t("world.aiSaving", "Saving the world…")}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {PHASE_ORDER.map((step, index) => (
          <div key={step} className="space-y-1.5">
            <div
              className={`h-1 rounded-full ${
                index <= currentIndex ? "bg-primary" : "bg-muted-foreground/20"
              }`}
            />
            <p className="text-[10px] text-muted-foreground">{labels[step]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
