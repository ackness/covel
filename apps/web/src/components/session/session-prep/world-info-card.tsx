import { MapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { text } from "@/components/world/editor-helpers.js";
import { worldVisual } from "@/lib/world-visuals.js";
import type * as api from "@/services/api.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";

interface WorldInfoCardProps {
  world: api.WorldRecord;
  expanded: boolean;
  onToggle: () => void;
}

export function WorldInfoCard({
  world,
  expanded,
  onToggle,
}: WorldInfoCardProps) {
  const visual = worldVisual(world);

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        summary={text(world.description) || undefined}
      >
        <MapIcon className="w-4 h-4" />
        {text(world.name)}
        {world.tags && world.tags.length > 0 && (
          <Badge variant="outline" className="text-[10px] ml-1">
            {world.tags.length} tags
          </Badge>
        )}
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent className="px-4 pb-4">
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
                {text(world.description)}
              </p>
              {world.tags && world.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {world.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
