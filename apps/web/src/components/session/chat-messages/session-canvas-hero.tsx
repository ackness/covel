import { useTranslation } from "react-i18next";
import { Flame } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { resolveI18n } from "@/lib/catalog.js";
import type { WorldRecord } from "@/services/api.js";

interface SessionCanvasHeroProps {
  world: WorldRecord | null;
  onBegin: () => void;
  beginLabel: string;
  hintLabel: string;
}

export function SessionCanvasHero({
  world,
  onBegin,
  beginLabel,
  hintLabel,
}: SessionCanvasHeroProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  const worldName = world ? resolveI18n(world.name, locale) : "";
  const start = world?.dimensions?.startingConditions;
  const hook = start?.openingHook
    ? resolveI18n(start.openingHook, locale)
    : worldName;
  const chips: string[] = (() => {
    if (start?.openingChips && start.openingChips.length > 0) {
      return start.openingChips
        .map((chip) => resolveI18n(chip, locale))
        .filter((s) => s.length > 0);
    }
    if (world?.tags && world.tags.length > 0) {
      return world.tags.slice(0, 3).map((tag) => String(tag));
    }
    return [];
  })();
  const summary = world ? resolveI18n(world.description, locale) : "";

  return (
    <div className="ui-session-canvas py-8 md:py-12 max-w-3xl mx-auto px-1">
      {/* Eyebrow + chip row — editorial "kicker" */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <span className="ui-eyebrow">§ SESSION CANVAS</span>
        {chips.map((chip, i) => (
          <span key={`${chip}-${i}`} className="ui-chip text-[10px]">
            {chip}
          </span>
        ))}
      </div>

      {/* Display title — the chosen hook or the world name */}
      <h2
        className="ui-title text-2xl md:text-[2.25rem] leading-tight tracking-tight mb-4"
        style={{ textWrap: "balance" } as React.CSSProperties}
      >
        {hook || hintLabel}
      </h2>

      {/* Body copy — fall back to summary, then to the i18n hint */}
      {(summary || hintLabel) && (
        <p className="ui-empty-copy text-sm md:text-base leading-relaxed mb-6 not-italic text-muted-foreground">
          {summary || hintLabel}
        </p>
      )}

      <Button
        size="lg"
        className="px-8 py-5 text-sm uppercase tracking-widest font-bold"
        onClick={onBegin}
      >
        <Flame className="w-4 h-4 mr-2" />
        {beginLabel}
      </Button>
    </div>
  );
}
