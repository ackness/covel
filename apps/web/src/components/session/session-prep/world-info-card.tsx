import { MapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { worldDisplayText } from "@/lib/world-locale.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { worldPackageInfo } from "@/lib/package-info.js";
import { PackageCredits } from "@/components/shared/package-credits.js";
import type * as api from "@/services/api.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";
import { useTranslation } from "react-i18next";

interface WorldInfoCardProps {
  world: api.WorldSummary;
  playLocale: string;
  expanded: boolean;
  onToggle: () => void;
}

export function WorldInfoCard({
  world,
  playLocale,
  expanded,
  onToggle,
}: WorldInfoCardProps) {
  const { t } = useTranslation();
  const visual = worldVisual(world);
  const displayText = worldDisplayText(world, playLocale);

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        contentId="world-info-card-content"
        summary={displayText.description || undefined}
      >
        <MapIcon className="w-4 h-4" />
        {displayText.name}
        {world.tags && world.tags.length > 0 && (
          <Badge variant="outline" className="text-xs ml-1">
            {t("session.tagsCount", { count: world.tags.length })}
          </Badge>
        )}
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent id="world-info-card-content" className="px-4 pb-4">
          <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
            <div className="relative aspect-4/3 overflow-hidden rounded-(--radius-card) border border-border bg-muted">
              <img
                src={visual.image}
                alt=""
                aria-hidden="true"
                width={1536}
                height={1024}
                loading="lazy"
                className="h-full w-full object-cover"
                draggable={false}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground wrap-break-word">
                {displayText.description}
              </p>
              {world.tags && world.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {world.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              <PackageCredits
                info={worldPackageInfo(world)}
                packageName={displayText.name || world.id}
              />
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
