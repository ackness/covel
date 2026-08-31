import type { TFunction } from "i18next";
import type {
  WorldExperienceMode,
  WorldPackageContentKind,
} from "@covel/shared";
import {
  Backpack,
  BookOpenText,
  Check,
  MessagesSquare,
  Route,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface WorldCreationOptionsProps {
  t: TFunction;
  experienceMode: WorldExperienceMode;
  content: ReadonlySet<WorldPackageContentKind>;
  additionalInstructions: string;
  disabled: boolean;
  onExperienceModeChange: (mode: WorldExperienceMode) => void;
  onToggleContent: (kind: WorldPackageContentKind) => void;
  onAdditionalInstructionsChange: (value: string) => void;
}

const EXPERIENCE_OPTIONS: ReadonlyArray<{
  mode: WorldExperienceMode;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    mode: "traditional-story",
    icon: Route,
    labelKey: "world.aiExperienceStory",
    descriptionKey: "world.aiExperienceStoryDesc",
  },
  {
    mode: "dialogue-mode",
    icon: MessagesSquare,
    labelKey: "world.aiExperienceDialogue",
    descriptionKey: "world.aiExperienceDialogueDesc",
  },
];

const CONTENT_OPTIONS: ReadonlyArray<{
  kind: WorldPackageContentKind;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    kind: "characters",
    icon: Users,
    labelKey: "world.aiContentCharacters",
    descriptionKey: "world.aiContentCharactersDesc",
  },
  {
    kind: "lorebook",
    icon: BookOpenText,
    labelKey: "world.aiContentLorebook",
    descriptionKey: "world.aiContentLorebookDesc",
  },
  {
    kind: "rules",
    icon: ShieldCheck,
    labelKey: "world.aiContentRules",
    descriptionKey: "world.aiContentRulesDesc",
  },
  {
    kind: "memory",
    icon: Sparkles,
    labelKey: "world.aiContentMemory",
    descriptionKey: "world.aiContentMemoryDesc",
  },
  {
    kind: "opening-kit",
    icon: Backpack,
    labelKey: "world.aiContentOpeningKit",
    descriptionKey: "world.aiContentOpeningKitDesc",
  },
];

export function WorldCreationOptions({
  t,
  experienceMode,
  content,
  additionalInstructions,
  disabled,
  onExperienceModeChange,
  onToggleContent,
  onAdditionalInstructionsChange,
}: WorldCreationOptionsProps) {
  return (
    <section className="rounded-(--radius-card) border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="ui-eyebrow text-primary">
            {t("world.aiPackageTitle", "World package plan")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(
              "world.aiPackageDesc",
              "Choose what the agent should author and keep consistent.",
            )}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-primary/25 bg-primary/8 px-2 py-1 font-mono text-[10px] text-primary">
          {t("world.aiPackageCount", { count: content.size })}
        </span>
      </div>

      <div className="mt-4">
        <p className="ui-eyebrow text-muted-foreground">
          {t("world.aiExperienceLabel", "Player experience")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {EXPERIENCE_OPTIONS.map((option) => {
            const selected = experienceMode === option.mode;
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onExperienceModeChange(option.mode)}
                className={`rounded-(--radius-control) border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? "border-primary/55 bg-primary/8"
                    : "border-border bg-background/60 hover:border-primary/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${selected ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span className="text-xs font-medium">
                    {t(option.labelKey)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {t(option.descriptionKey)}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <p className="ui-eyebrow text-muted-foreground">
          {t("world.aiContentLabel", "Package supplements")}
        </p>
        <div className="mt-2 space-y-1.5">
          {CONTENT_OPTIONS.map((option) => {
            const selected = content.has(option.kind);
            const Icon = option.icon;
            return (
              <button
                key={option.kind}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onToggleContent(option.kind)}
                className={`flex w-full items-center gap-3 rounded-(--radius-control) border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? "border-primary/35 bg-primary/6"
                    : "border-transparent bg-background/40 hover:border-border"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {selected ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">
                    {t(option.labelKey)}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {t(option.descriptionKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="world-additional-instructions"
            className="ui-eyebrow text-muted-foreground"
          >
            {t("world.aiAdditionalLabel", "Author notes")}
          </label>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {additionalInstructions.length}/2000
          </span>
        </div>
        <textarea
          id="world-additional-instructions"
          className="mt-2 flex min-h-20 w-full resize-none rounded-(--radius-control) border border-border bg-background/70 px-3 py-2.5 text-xs leading-relaxed placeholder:text-muted-foreground/60 focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          value={additionalInstructions}
          onChange={(event) =>
            onAdditionalInstructionsChange(event.target.value)
          }
          placeholder={t(
            "world.aiAdditionalPlaceholder",
            "Must-have relationships, taboos, pacing, or content to avoid…",
          )}
          disabled={disabled}
          maxLength={2000}
        />
      </div>
    </section>
  );
}
