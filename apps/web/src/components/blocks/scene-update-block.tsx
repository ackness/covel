import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { MapPin, Clock, Cloud, Users } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

export function SceneUpdateBlock({ data }: BlockRendererProps) {
  const location = data.location as string | undefined;
  const subLocation = data.sub_location as string | undefined;
  const time = data.time as string | undefined;
  const weather = data.weather as string | undefined;
  const description = data.description as string | undefined;
  const npcsPresent = (data.npcs_present as string[]) ?? [];
  const mood = data.mood as string | undefined;

  return (
    <Card className="max-w-md bg-blue-500/5 border-blue-500/20">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-blue-500" />
          <span className="text-[10px] uppercase tracking-widest text-blue-600 dark:text-blue-400 font-semibold">
            Scene Update
          </span>
          {mood && (
            <Badge variant="outline" className="rounded-none text-[9px] py-0 ml-auto">
              {mood}
            </Badge>
          )}
        </div>

        {/* Location */}
        {location && (
          <div className="flex items-center gap-2 text-xs">
            <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium">{location}</span>
            {subLocation && (
              <span className="text-muted-foreground">/ {subLocation}</span>
            )}
          </div>
        )}

        {/* Time & Weather */}
        <div className="flex flex-wrap gap-3">
          {time && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0" />
              <span>{time}</span>
            </div>
          )}
          {weather && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cloud className="h-3 w-3 shrink-0" />
              <span>{weather}</span>
            </div>
          )}
        </div>

        {/* Description */}
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed border-t border-border pt-2">
            {description}
          </p>
        )}

        {/* NPCs present */}
        {npcsPresent.length > 0 && (
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <Users className="h-3 w-3 text-muted-foreground shrink-0" />
            <div className="flex flex-wrap gap-1">
              {npcsPresent.map((npc) => (
                <Badge key={npc} variant="secondary" className="text-[9px] rounded-none py-0">
                  {npc}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
