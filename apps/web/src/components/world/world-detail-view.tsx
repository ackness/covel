import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Separator } from "@/components/ui/separator.js";
import { text } from "./world-detail/detail-primitives.js";
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
}

export function WorldDetailView({
  world,
  onClose,
  onEdit,
}: WorldDetailViewProps) {
  const { t } = useTranslation();
  const dims = world.dimensions;

  const hasDimensions =
    dims &&
    Object.values(dims).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-4">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onClose}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-lg font-bold flex-1">{text(world.name)}</h2>
            {world.locale && <Badge variant="outline">{world.locale}</Badge>}
            {onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                {t("common.edit")}
              </Button>
            )}
          </div>
          {world.tags && world.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-10">
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
          <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
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
    </ScrollArea>
  );
}
