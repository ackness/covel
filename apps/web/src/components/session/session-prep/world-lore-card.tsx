import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";

interface WorldLoreCardProps {
  expanded: boolean;
  onToggle: () => void;
  loreValue: string;
  originalLore: string;
  isModified: boolean;
  onLoreChange: (value: string) => void;
  onResetLore: () => void;
}

export function WorldLoreCard({
  expanded,
  onToggle,
  loreValue,
  originalLore,
  isModified,
  onLoreChange,
  onResetLore,
}: WorldLoreCardProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        summary={
          isModified
            ? t("session.modified")
            : t("session.loreSummaryHint", {
                count: originalLore.length,
                defaultValue: "{{count}} characters · click to edit world lore",
              })
        }
      >
        <FileText className="w-4 h-4" />
        {t("session.worldLore", "World Document")}
        {isModified && (
          <Badge variant="secondary" className="text-[10px] ml-1">
            {t("session.modified")}
          </Badge>
        )}
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent className="space-y-3 px-4 pb-4">
          <textarea
            value={loreValue}
            onChange={(event) => onLoreChange(event.target.value)}
            className="w-full min-h-[300px] bg-background border border-border px-4 py-3 text-sm font-mono leading-relaxed outline-none focus:ring-1 focus:ring-primary resize-y"
            placeholder={t("session.lorePlaceholder")}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {isModified
                ? t("session.loreModified", { count: loreValue.length })
                : t("session.loreOriginal", {
                    count: originalLore.length,
                  })}
            </span>
            {isModified && (
              <button
                className="text-xs text-muted-foreground hover:text-primary underline"
                onClick={onResetLore}
              >
                {t("session.resetLore", "Reset to original")}
              </button>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
