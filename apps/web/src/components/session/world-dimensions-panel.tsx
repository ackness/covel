/**
 * Compact world dimensions panel for the right panel world tab.
 * Shows geography, factions, power system, history, economy, tone, mechanics
 * in collapsible sections.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MapPin,
  Users,
  Zap,
  Clock,
  Coins,
  Building2,
  Palette,
  Gamepad2,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import type { WorldDimensions } from "@covel/shared";
import { text } from "@/components/world/editor-helpers.js";

function Section({
  title,
  icon: Icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Icon className="w-3 h-3" />
        <span>{title}</span>
      </button>
      {open && (
        <div className="border-l border-border pl-3 ml-1.5 space-y-1 pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function WorldDimensionsPanel({
  dimensions,
}: {
  dimensions: WorldDimensions;
}) {
  const { t } = useTranslation();
  const dims = dimensions;

  return (
    <div className="space-y-1">
      {/* Geography */}
      {dims.geography && (
        <Section title={t("world.geography")} icon={MapPin}>
          {dims.geography.overview && (
            <p className="text-[11px] text-muted-foreground">
              {text(dims.geography.overview)}
            </p>
          )}
          {dims.geography.regions.map((r, i) => (
            <div key={i} className="text-[11px]">
              <span className="font-medium">{text(r.name)}</span>
              {r.climate && (
                <span className="text-muted-foreground">
                  {" "}
                  · {text(r.climate)}
                </span>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Factions */}
      {dims.factions && dims.factions.length > 0 && (
        <Section title={t("world.factions")} icon={Users}>
          {dims.factions.map((f) => (
            <div
              key={f.id}
              className="text-[11px] flex items-center gap-1 flex-wrap"
            >
              <span className="font-medium">{text(f.name)}</span>
              <Badge
                variant="outline"
                className="text-[9px] rounded-none py-0 h-4"
              >
                {f.influence}
              </Badge>
              {f.leader && (
                <span className="text-muted-foreground text-[10px]">
                  {text(f.leader)}
                </span>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Power System */}
      {dims.powerSystem && (
        <Section title={t("world.powerSystem")} icon={Zap}>
          <div className="text-[11px]">
            <span className="font-medium">{text(dims.powerSystem.name)}</span>
            <span className="text-muted-foreground">
              {" "}
              ({dims.powerSystem.type})
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {text(dims.powerSystem.description)}
          </p>
          {dims.powerSystem.tiers && dims.powerSystem.tiers.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {[...dims.powerSystem.tiers]
                .sort((a, b) => a.rank - b.rank)
                .map((tier, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-[9px] rounded-none py-0 h-4"
                  >
                    {tier.rank}. {text(tier.name)}
                  </Badge>
                ))}
            </div>
          )}
        </Section>
      )}

      {/* History */}
      {dims.history && dims.history.length > 0 && (
        <Section title={t("world.history")} icon={Clock}>
          {dims.history.map((evt, i) => (
            <div key={i} className="text-[11px]">
              <span className="font-medium">{text(evt.name)}</span>
              <span className="text-muted-foreground">
                {" "}
                · {[text(evt.era), text(evt.year)].filter(Boolean).join(" ")}
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* Economy */}
      {dims.economy && (
        <Section title={t("world.economy")} icon={Coins}>
          {dims.economy.currencies.map((c, i) => (
            <div key={i} className="text-[11px]">
              <span className="font-medium">{text(c.name)}</span>
              {c.symbol && <span> ({c.symbol})</span>}
              {c.description && (
                <span className="text-muted-foreground">
                  {" "}
                  — {text(c.description)}
                </span>
              )}
            </div>
          ))}
          {dims.economy.resources && dims.economy.resources.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {dims.economy.resources.map((r, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-[9px] rounded-none py-0 h-4"
                >
                  {text(r)}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Social Structure */}
      {dims.socialStructure && (
        <Section title={t("world.socialStructure")} icon={Building2}>
          {dims.socialStructure.classes?.map((cls, i) => (
            <div key={i} className="text-[11px]">
              <span className="font-medium">{text(cls.name)}</span>
              {cls.description && (
                <span className="text-muted-foreground">
                  {" "}
                  — {text(cls.description)}
                </span>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Tone */}
      {dims.tone && (
        <Section title={t("world.tone")} icon={Palette}>
          <div className="flex flex-wrap gap-1">
            {dims.tone.genres.map((g, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="text-[9px] rounded-none py-0 h-4"
              >
                {g}
              </Badge>
            ))}
          </div>
          {dims.tone.themes && dims.tone.themes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {dims.tone.themes.map((th, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-[9px] rounded-none py-0 h-4"
                >
                  {text(th)}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Mechanics */}
      {dims.mechanics && (
        <Section title={t("world.mechanics")} icon={Gamepad2}>
          <div className="flex flex-wrap gap-1">
            {dims.mechanics.combatStyle && (
              <Badge
                variant="secondary"
                className="text-[9px] rounded-none py-0 h-4"
              >
                {dims.mechanics.combatStyle}
              </Badge>
            )}
            {dims.mechanics.difficulty && (
              <Badge
                variant="outline"
                className="text-[9px] rounded-none py-0 h-4"
              >
                {dims.mechanics.difficulty}
              </Badge>
            )}
          </div>
          {dims.mechanics.skillSystem && (
            <p className="text-[11px] text-muted-foreground">
              {text(dims.mechanics.skillSystem)}
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
