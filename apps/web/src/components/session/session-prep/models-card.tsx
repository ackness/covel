import { Cpu, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { ActiveModelSlots } from "../active-model-slots.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";

interface ModelsCardProps {
  resolvedSlots: ResolvedSlot[];
  expanded: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
}

export function ModelsCard({
  resolvedSlots,
  expanded,
  onToggle,
  onOpenSettings,
}: ModelsCardProps) {
  const { t } = useTranslation();

  return (
    <Card className="mb-4">
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        summary={
          resolvedSlots.length > 0
            ? t("session.slotsConfigured", {
                count: resolvedSlots.length,
              })
            : t("session.slotsUnconfigured")
        }
      >
        <Cpu className="w-4 h-4" />
        {t("session.activeModels", "Active Models")}
        <Badge variant="secondary" className="text-[10px] ml-1">
          {resolvedSlots.length}
        </Badge>
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent className="space-y-2">
          <ActiveModelSlots slots={resolvedSlots} />
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
            onClick={onOpenSettings}
          >
            <KeyRound className="w-3.5 h-3.5 mr-1.5" />
            {t("session.configureKeys", "Configure API Keys & Presets")}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
