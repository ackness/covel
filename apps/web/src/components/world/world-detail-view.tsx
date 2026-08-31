import { useTranslation } from "react-i18next";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Separator } from "@/components/ui/separator.js";
import { text } from "./world-detail/detail-primitives.js";
import { worldLanguage, worldLanguageBadge } from "@/lib/world-locale.js";
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
  const { t } = useTranslation();
  const dims = world.dimensions;
  const language = worldLanguage(world.locale);
  const languageCode = worldLanguageBadge(world.locale);
  const languageBadge =
    language === "zh" ? t("world.languageBadgeChinese", "ZH") : languageCode;
  const languageName =
    language === "en"
      ? t("world.languageEnglish", "English")
      : language === "zh"
        ? t("world.languageChinese", "Chinese")
        : world.locale;

  const hasDimensions =
    dims &&
    Object.values(dims).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 md:px-8 md:py-8">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t("world.backToList")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="min-w-0 flex-1 text-lg font-bold">
              {text(world.name)}
            </h2>
            {languageBadge && languageName && (
              <Badge
                variant="outline"
                title={t("world.languageLabel", {
                  language: languageName,
                  defaultValue: "World language: {{language}}",
                })}
              >
                {languageBadge}
              </Badge>
            )}
            {onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                {t("common.edit")}
              </Button>
            )}
            {onDelete && (
              <Button variant="destructive" size="sm" onClick={onDelete}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t("world.delete", "Delete world")}
              </Button>
            )}
          </div>
          {world.tags && world.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 sm:pl-10">
              {world.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Description */}
        {world.description && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground wrap-break-word">
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
