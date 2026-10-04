import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { PingButton } from "@/components/shared/ping-button.js";
import {
  formatSlotModelLabel,
  type ResolvedSlot,
} from "@/hooks/use-slot-config.js";

/**
 * Displays the user's configured model slots.
 *
 * Each row embeds a <PingButton> so the user can verify connectivity /
 * latency without leaving the game view. Results are cached for 60s at
 * the PingButton layer, so repeat clicks are free until the cache expires.
 *
 * Variants:
 *   - `card` — used on the prep screen; shows model and Ping inline.
 *   - `compact` — used in the session sidebar; one row per slot with its
 *     model and the icon-only Ping.
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
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noModelsConfigured")}
      </p>
    );
  }

  if (variant === "compact") {
    return (
      <ul className="divide-y divide-(--rule-color) overflow-hidden rounded-(--radius-control) border border-(--rule-color)">
        {slots.map((slot) => {
          const modelName = formatSlotModelLabel(slot) ?? "unknown";
          const provider = slot.preset?.provider ?? slot.serverProvider ?? "";
          const tooltip = [slot.label, provider, modelName]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={slot.slotId}
              className="flex items-center gap-2 py-1.5 pl-2.5 pr-1.5"
              title={tooltip}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium leading-tight">
                  {slot.label}
                </p>
                <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
                  {modelName}
                </p>
              </div>
              <PingButton
                target={{ kind: "slot", slotId: slot.slotId }}
                variant="icon"
                size="xs"
                className="border-transparent bg-transparent shadow-none dark:border-transparent dark:bg-transparent"
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      {slots.map((slot) => {
        const modelName = slot.preset?.model ?? slot.serverModel ?? "unknown";
        const displayName = formatSlotModelLabel(slot) ?? slot.presetId;
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
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {slot.label}
                  </Badge>
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
