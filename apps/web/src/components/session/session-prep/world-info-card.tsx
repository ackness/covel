import { MapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { text } from "@/components/world/editor-helpers.js";
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
  return (
    <Card className="mb-4">
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
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
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
        </CardContent>
      )}
    </Card>
  );
}
