import { type CSSProperties } from "react";
import type { TFunction } from "i18next";
import { Eye, Trash2, ArrowRight } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { worldVisual } from "@/lib/world-visuals.js";

export interface WorldCardProps {
  world: WorldRecord;
  /** Zero-based position in the list — drives the № label and eager loading. */
  index: number;
  /** Whether this card is currently entering its world. */
  isEntering: boolean;
  /** Whether another card is entering (dims and disables this one). */
  dimmed: boolean;
  /** Resolved storage label (e.g. "Built-in", "Server file"). */
  storageLabel: string;
  t: TFunction;
  onEnter: (worldId: string) => void;
  onViewDetails: (e: React.MouseEvent, worldId: string) => void;
  onDelete: (e: React.MouseEvent, worldId: string) => void;
}

/**
 * Single cover-led world plate in the world-select grid. Renders the cover
 * image, gradient overlays, title/description, tag chips, and the
 * view-details / delete / enter action surface.
 */
export function WorldCard({
  world,
  index,
  isEntering,
  dimmed,
  storageLabel,
  t,
  onEnter,
  onViewDetails,
  onDelete,
}: WorldCardProps) {
  const visual = worldVisual(world);
  return (
    <article
      aria-busy={isEntering}
      onClick={() => onEnter(world.id)}
      className={`group relative min-h-[320px] md:min-h-[332px] cursor-pointer overflow-hidden rounded-[var(--radius-card)] border border-border bg-card transition-all hover:border-primary/40 ${
        isEntering ? "opacity-100" : ""
      } ${dimmed ? "opacity-30 pointer-events-none" : ""}`}
      style={
        {
          "--world-accent": visual.accent,
          boxShadow: isEntering
            ? "0 24px 80px -50px var(--world-accent)"
            : undefined,
        } as CSSProperties
      }
    >
      <img
        src={visual.image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        loading={index < 2 ? "eager" : "lazy"}
        fetchPriority={index < 2 ? "high" : "auto"}
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"
        draggable={false}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,.08) 0%, rgba(0,0,0,.42) 46%, rgba(0,0,0,.78) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-75"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,.62) 0%, rgba(0,0,0,.24) 58%, rgba(0,0,0,.18) 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute left-0 top-0 h-1 w-24 transition-all group-hover:w-40"
        style={{ background: "var(--world-accent)" }}
      />

      <div className="relative z-10 flex min-h-[320px] md:min-h-[332px] flex-col justify-between p-5 md:p-6 text-white">
        <div className="flex items-start justify-between gap-4">
          <span className="ui-meta text-[10px] text-white/62 tabular-nums">
            № {String(index + 1).padStart(2, "0")} · {world.id}
          </span>
          <span
            className="ui-tag border-white/18 bg-black/18 text-white/70 backdrop-blur-sm"
            title={t("session.worldStorage", "World storage")}
          >
            {storageLabel}
          </span>
        </div>

        <div className="space-y-3.5">
          <div className="max-w-[31rem] space-y-2.5">
            <h2
              className="ui-title text-3xl md:text-[2.35rem] leading-[1.02] tracking-tight text-white transition-colors"
              style={isEntering ? { color: "var(--world-accent)" } : undefined}
            >
              {text(world.name)}
            </h2>
            <p className="text-[14px] leading-relaxed text-white/76 line-clamp-3 break-words [overflow-wrap:anywhere]">
              {text(world.description)}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(world.tags ?? []).slice(0, 5).map((tag) => (
              <span
                key={tag}
                className="ui-tag border-white/16 bg-black/20 text-white/62 backdrop-blur-sm"
              >
                {tag}
              </span>
            ))}
            {(world.tags?.length ?? 0) > 5 && (
              <span className="ui-meta text-[10px] text-white/54 self-center">
                +{(world.tags?.length ?? 0) - 5}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-white/14 pt-3.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => onViewDetails(e, world.id)}
                aria-label={t("world.viewDetails", "View details")}
                className="ui-btn ui-btn-quiet h-8 w-8 border-white/12 bg-black/12 p-0 text-white/72 hover:bg-white/10 hover:text-white"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
              {world.metadata?.source !== "file" && (
                <button
                  type="button"
                  onClick={(e) => onDelete(e, world.id)}
                  aria-label={t("world.delete", "Delete world")}
                  className="ui-btn ui-btn-quiet h-8 w-8 border-white/12 bg-black/12 p-0 text-white/72 hover:text-[var(--accent-danger)]"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <span
              className="ui-meta inline-flex items-center gap-1.5 transition-all group-hover:gap-2.5"
              style={{ color: "var(--world-accent)" }}
            >
              {t("session.enter", "Enter")}
              <ArrowRight className="w-3 h-3" />
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
