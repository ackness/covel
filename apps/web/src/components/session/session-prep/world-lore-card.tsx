import { useMemo } from "react";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WORLD_LORE_TOKEN_BUDGET, fitWorldLore } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";
import type { LoreDraftStatus } from "./use-world-lore.js";

interface WorldLoreCardProps {
  expanded: boolean;
  onToggle: () => void;
  loreValue: string;
  originalLore: string;
  isModified: boolean;
  onLoreChange: (value: string) => void;
  onResetLore: () => void;
  draftStatus: LoreDraftStatus;
  /** The world's full record has not arrived: there is no text to edit yet. */
  locked?: boolean;
  onRetry: () => void;
}

export function WorldLoreCard({
  expanded,
  onToggle,
  loreValue,
  originalLore,
  isModified,
  onLoreChange,
  onResetLore,
  draftStatus,
  locked = false,
  onRetry,
}: WorldLoreCardProps) {
  const { t } = useTranslation();
  // The story prompt carries only the first part of the lore: say so while the
  // player edits, with the measure the world page and `validate:world` use.
  const fitted = useMemo(() => fitWorldLore(loreValue), [loreValue]);

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        contentId="world-lore-card-content"
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
          <Badge variant="secondary" className="text-xs ml-1">
            {t("session.modified")}
          </Badge>
        )}
      </CollapsibleCardHeader>
      {draftStatus !== "ready" && (
        <div
          className="px-4 pb-3 text-xs text-muted-foreground"
          role={draftStatus.endsWith("error") ? "alert" : "status"}
        >
          {t(`session.loreDraft.${draftStatus}`)}
          {draftStatus.endsWith("error") && (
            <button
              type="button"
              className="ml-2 underline hover:text-primary"
              onClick={onRetry}
            >
              {t("common.retry", "Retry")}
            </button>
          )}
        </div>
      )}
      {expanded && (
        <CardContent
          id="world-lore-card-content"
          className="space-y-3 px-4 pb-4"
        >
          <textarea
            value={loreValue}
            disabled={locked}
            onChange={(event) => onLoreChange(event.target.value)}
            className="w-full min-h-75 bg-background border border-border px-4 py-3 text-sm font-mono leading-relaxed outline-none focus:ring-1 focus:ring-primary resize-y"
            placeholder={t("session.lorePlaceholder")}
            aria-label={t("session.worldLore", "World Document")}
          />
          {fitted.truncated && (
            <p
              role="note"
              className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
              {t("world.loreTooLong", {
                tokens: fitted.tokens,
                budget: WORLD_LORE_TOKEN_BUDGET,
              })}
            </p>
          )}
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
                type="button"
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
