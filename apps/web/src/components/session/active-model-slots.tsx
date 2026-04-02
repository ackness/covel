import { Cpu } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

/**
 * Displays the user's configured model slots.
 * Two variants: "card" for prep screen, "compact" for sidebar.
 */
export function ActiveModelSlots({
  slots,
  variant = "card",
}: {
  slots: ResolvedSlot[];
  variant?: "card" | "compact";
}) {
  if (slots.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No models configured</p>;
  }

  if (variant === "compact") {
    return (
      <div className="space-y-1">
        {slots.map((slot) => (
          <div key={slot.slotId} className="flex items-center justify-between py-1.5 px-2 bg-muted/30 text-xs">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-10 shrink-0">
                {slot.label}
              </span>
              <span className="truncate font-medium">
                {slot.preset?.model ?? "unknown"}
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
              {slot.preset?.name ?? slot.presetId}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {slots.map((slot) => (
        <Card key={slot.slotId}>
          <CardContent className="p-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 shrink-0 text-primary" />
              <span className="text-sm font-medium truncate">
                {slot.preset?.name ?? slot.presetId}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">{slot.label}</Badge>
              <Badge variant="default" className="shrink-0">
                {slot.preset?.model ?? "unknown"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
