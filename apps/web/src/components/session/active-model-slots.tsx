import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { PingButton } from "@/components/shared/ping-button.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

/**
 * Displays the user's configured model slots.
 *
 * Each row embeds a <PingButton> so the user can verify connectivity /
 * latency without leaving the game view. Results are cached for 60s at
 * the PingButton layer, so repeat clicks are free until the cache expires.
 *
 * Variants:
 *   - `card` — used on the prep screen; shows model and Ping inline.
 *   - `compact` — used in the session sidebar; uses the icon-only variant
 *     to fit the narrow column.
 */
export function ActiveModelSlots({
  slots,
  variant = "card",
}: {
  slots: ResolvedSlot[];
  variant?: "card" | "compact";
}) {
  const { t } = useTranslation();

  if (slots.length === 0) {
    return <p className="text-xs text-muted-foreground italic">{t("session.noModelsConfigured")}</p>;
  }

  if (variant === "compact") {
    return (
      <div className="space-y-1">
        {slots.map((slot) => {
          const modelName = slot.preset?.model ?? slot.serverModel ?? "unknown";
          const provider = slot.preset?.provider ?? slot.serverProvider ?? "";
          return (
            <div key={slot.slotId} className="flex items-center justify-between py-1.5 px-2 bg-muted/30 text-xs">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">
                  {slot.label}
                </span>
                <span className="truncate font-medium">
                  {modelName}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-1">
                {provider && (
                  <span className="text-[10px] text-muted-foreground">
                    {provider}
                  </span>
                )}
                <PingButton
                  target={{ kind: "slot", slotId: slot.slotId }}
                  variant="icon"
                  size="xs"
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      {slots.map((slot) => {
        const modelName = slot.preset?.model ?? slot.serverModel ?? "unknown";
        const displayName = slot.preset?.name ?? slot.serverModel ?? slot.presetId;
        return (
          <Card key={slot.slotId}>
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Cpu className="w-4 h-4 shrink-0 text-primary" />
                  <span className="text-sm font-medium truncate">
                    {displayName}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant="outline" className="text-[10px] uppercase">{slot.label}</Badge>
                  <Badge variant="default" className="shrink-0">
                    {modelName}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-end">
                <PingButton
                  target={{ kind: "slot", slotId: slot.slotId }}
                  size="xs"
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
