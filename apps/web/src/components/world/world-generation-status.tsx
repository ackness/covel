import type { TFunction } from "i18next";
import { AlertCircle, Check, Circle, Loader2 } from "lucide-react";
import type { WorldGenerationPart } from "@covel/shared";

export type WorldGenerationPhase =
  "idle" | "generating" | "validating" | "saving" | "done" | "error";

interface WorldGenerationStatusProps {
  phase: WorldGenerationPhase;
  error: string | null;
  t: TFunction;
  /** What to say when the work is done; a new world by default. */
  doneLabel?: string;
  /** The parts the model writes, as the server last reported them. */
  parts?: readonly WorldGenerationPart[];
  /** Why the request failed, when the server names the cause. */
  errorCode?: "model_idle_timeout";
}

const PHASE_ORDER = ["generating", "validating", "saving"] as const;

function partLabel(part: WorldGenerationPart, t: TFunction): string {
  switch (part.id) {
    case "manifest":
      return t("world.aiPartManifest", "World settings");
    case "lore":
      return t("world.aiPartLore", "World lore");
    case "characters":
      return t("world.aiContentCharacters");
    case "lorebook":
      return t("world.aiContentLorebook");
    case "rules":
      return t("world.aiContentRules");
    case "revision":
      return t("world.aiPartRevision", "Requested change");
    default:
      // Plugin-owned content is named by the plugin that receives it.
      return part.title ?? part.id;
  }
}

function partDetail(part: WorldGenerationPart, t: TFunction): string {
  if (part.state === "failed") {
    return t("world.aiPartFailed", "not generated");
  }
  if (part.state !== "active") return "";
  return [
    part.chars
      ? t("world.aiPartChars", "{{chars}} characters written", {
          chars: part.chars,
        })
      : "",
    (part.attempt ?? 1) > 1
      ? t("world.aiPartAttempt", "attempt {{attempt}}", {
          attempt: part.attempt,
        })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Each part of the world on a line: written, being written, waiting, or not generated. */
function PartList({
  parts,
  t,
}: {
  parts: readonly WorldGenerationPart[];
  t: TFunction;
}) {
  return (
    <ul className="mt-3 space-y-1.5">
      {parts.map((part) => {
        const detail = partDetail(part, t);
        return (
          <li
            key={part.id}
            data-state={part.state}
            className="flex items-center gap-2 text-xs"
          >
            {part.state === "done" ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : part.state === "active" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            ) : part.state === "failed" ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            )}
            <span
              className={
                part.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground"
              }
            >
              {partLabel(part, t)}
            </span>
            {detail && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {detail}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function WorldGenerationStatus({
  phase,
  error,
  t,
  doneLabel,
  parts = [],
  errorCode,
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
          {errorCode === "model_idle_timeout" && (
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              {t(
                "world.aiIdleTimeoutHint",
                'The model sent nothing for the whole wait. You can set a longer wait in Settings → {{group}}: "World authoring: wait for the model".',
                { group: t("settings.groupGeneral", "General") },
              )}
            </p>
          )}
          {/* Shows how far the world got and which part stopped it. A request
              that broke off leaves its part active; nothing writes it now. */}
          {parts.length > 0 && (
            <PartList
              parts={parts.map((part) =>
                part.state === "active" ? { ...part, state: "failed" } : part,
              )}
              t={t}
            />
          )}
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="flex items-center gap-3 rounded-(--radius-control) border border-emerald-500/30 bg-emerald-500/10 p-4">
        <Check className="h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-sm font-medium text-emerald-500">
          {doneLabel ?? t("world.aiDone", "World is ready!")}
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
      {parts.length > 0 && <PartList parts={parts} t={t} />}
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
