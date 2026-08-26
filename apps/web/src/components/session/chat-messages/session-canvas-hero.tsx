import { useTranslation } from "react-i18next";
import { Flame } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { worldVisual } from "@/lib/world-visuals.js";
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
  const visual = worldVisual(world);

  return (
    <div
      className="ui-session-canvas relative mx-auto my-2 max-w-4xl overflow-hidden rounded-(--radius-card) border border-(--rule-color) bg-card"
      style={{ "--world-accent": visual.accent } as React.CSSProperties}
    >
      <img
        src={visual.image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        loading="eager"
        fetchPriority="high"
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.58) 55%, rgba(0,0,0,.24) 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute left-0 top-0 h-1 w-28"
        style={{ background: "var(--world-accent)" }}
      />

      <div className="relative z-10 flex min-h-90 flex-col justify-between p-5 text-white md:min-h-105 md:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ui-eyebrow text-white/62">§ SESSION CANVAS</span>
          {chips.map((chip, i) => (
            <span
              key={`${chip}-${i}`}
              className="ui-tag border-white/16 bg-black/20 text-white/70 backdrop-blur-sm"
            >
              {chip}
            </span>
          ))}
        </div>

        <div className="max-w-2xl">
          <h2
            className="ui-title text-3xl leading-tight tracking-tight text-white md:text-[2.65rem]"
            style={{ textWrap: "balance" } as React.CSSProperties}
          >
            {hook || hintLabel}
          </h2>

          {(summary || hintLabel) && (
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/72 md:text-base">
              {summary || hintLabel}
            </p>
          )}

          <Button
            size="lg"
            className="mt-7 px-7 py-5 text-sm font-bold uppercase tracking-widest"
            style={{ background: "var(--world-accent)", color: "black" }}
            onClick={onBegin}
          >
            <Flame className="w-4 h-4 mr-2" />
            {beginLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
