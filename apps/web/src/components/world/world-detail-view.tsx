import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Separator } from "@/components/ui/separator.js";
import { text } from "./world-detail/detail-primitives.js";
import { worldLanguageBadge, worldLanguageName } from "@/lib/world-locale.js";
import { worldVisual } from "@/lib/world-visuals.js";
import {
  GeographySection,
  FactionsSection,
  PowerSystemSection,
  HistorySection,
  EconomySection,
  SocialSection,
  ToneSection,
  MechanicsSection,
  StartingSection,
} from "./world-detail/world-detail-sections.js";

export interface WorldDetailViewProps {
  world: WorldRecord;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function WorldDetailView({
  world,
  onClose,
  onEdit,
  onDelete,
}: WorldDetailViewProps) {
  const { t, i18n } = useTranslation();
  const dims = world.dimensions;
  const languageBadge = worldLanguageBadge(world.locale);
  const languageName = worldLanguageName(
    world.locale,
    i18n.resolvedLanguage ?? i18n.language,
  );
  const visual = worldVisual(world);

  const hasDimensions =
    dims &&
    Object.values(dims).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <header
          className="relative min-h-64 overflow-hidden rounded-(--radius-card) border border-border bg-card"
          style={{ "--world-accent": visual.accent } as CSSProperties}
        >
          <img
            src={visual.image}
            alt=""
            aria-hidden="true"
            width={1536}
            height={1024}
            loading="eager"
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
          <div className="absolute inset-0 bg-linear-to-r from-black/85 via-black/62 to-black/24" />
          <div className="relative z-10 flex min-h-64 flex-col justify-between gap-8 p-5 text-white sm:p-7">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={t("world.backToList")}
                className="h-10 border border-white/18 bg-black/28 px-3 text-white hover:bg-white/12 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>{t("world.backToList")}</span>
              </Button>
              <div className="flex-1" />
              {languageBadge && languageName && (
                <Badge
                  variant="outline"
                  className="border-white/25 bg-black/24 text-white"
                  title={t("world.languageLabel", {
                    language: languageName,
                    defaultValue: "World language: {{language}}",
                  })}
                >
                  {languageBadge}
                </Badge>
              )}
              {onEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 border-white/25 bg-black/24 text-white hover:bg-white/12 hover:text-white"
                  onClick={onEdit}
                >
                  {t("common.edit")}
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-10"
                  onClick={onDelete}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("world.delete", "Delete world")}
                </Button>
              )}
            </div>
            <div className="max-w-3xl space-y-4">
              <h1 className="ui-title text-3xl leading-none text-white sm:text-5xl">
                {text(world.name)}
              </h1>
              {world.tags && world.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {world.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="border-white/15 bg-white/12 text-xs text-white"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Description */}
        {world.description && (
          <p className="max-w-3xl text-base leading-relaxed text-muted-foreground wrap-break-word">
            {text(world.description)}
          </p>
        )}

        <Separator />

        {/* Dimensions */}
        {hasDimensions && dims ? (
          <div className="space-y-4">
            {dims.geography && dims.geography.regions.length > 0 && (
              <GeographySection geo={dims.geography} t={t} />
            )}
            {dims.factions && dims.factions.length > 0 && (
              <FactionsSection factions={dims.factions} t={t} />
            )}
            {dims.powerSystem && (
              <PowerSystemSection ps={dims.powerSystem} t={t} />
            )}
            {dims.history && dims.history.length > 0 && (
              <HistorySection events={dims.history} t={t} />
            )}
            {dims.economy && <EconomySection economy={dims.economy} t={t} />}
            {dims.socialStructure && (
              <SocialSection social={dims.socialStructure} t={t} />
            )}
            {dims.tone && <ToneSection tone={dims.tone} t={t} />}
            {dims.mechanics && (
              <MechanicsSection mechanics={dims.mechanics} t={t} />
            )}
            {dims.startingConditions && (
              <StartingSection sc={dims.startingConditions} t={t} />
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{t("world.noStructuredData")}</p>
            {world.lore && (
              <div className="whitespace-pre-wrap rounded border border-border p-3 text-xs">
                {text(world.lore)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
