import { History, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import type * as api from "@/services/api.js";
import {
  formatSessionDate,
  sessionStatusLabel,
  sessionTurnLabel,
} from "@/lib/session-display.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";

interface SessionHistoryCardProps {
  activeSessions: api.SessionRecord[];
  expanded: boolean;
  onToggle: () => void;
  onResume: (session: api.SessionRecord) => void;
  /** Session id currently being resumed — locks its Resume button. */
  resumingId?: string | null;
  onRequestDelete: (session: api.SessionRecord) => void;
}

export function SessionHistoryCard({
  activeSessions,
  expanded,
  onToggle,
  onResume,
  resumingId,
  onRequestDelete,
}: SessionHistoryCardProps) {
  const { t, i18n } = useTranslation();

  if (activeSessions.length === 0) return null;

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
        contentId="session-history-content"
        summary={t("session.historySummary", {
          count: activeSessions.length,
        })}
      >
        <History className="w-4 h-4" />
        {t("session.history", "Previous Sessions")}
        <Badge variant="secondary" className="text-[10px] ml-1">
          {activeSessions.length}
        </Badge>
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent
          id="session-history-content"
          className="space-y-2 px-4 pb-4"
        >
          {activeSessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between border border-border px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    session.status === "active"
                      ? "bg-green-500"
                      : "bg-muted-foreground"
                  }`}
                />
                <div className="min-w-0">
                  <span className="text-xs font-mono text-muted-foreground">
                    {session.id.slice(0, 16)}
                  </span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="outline" className="text-[10px]">
                      {sessionStatusLabel(t, session.status)} ·{" "}
                      {sessionTurnLabel(t, session.completedPlayerTurns)}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {formatSessionDate(
                        session.createdAt,
                        i18n.resolvedLanguage ?? i18n.language,
                      )}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={Boolean(resumingId)}
                  onClick={() => onResume(session)}
                >
                  {resumingId === session.id && (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  )}
                  {resumingId === session.id
                    ? t("session.resuming", "Resuming…")
                    : t("session.resume")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                  aria-label={t("session.deleteSessionAria", {
                    id: session.id.slice(0, 16),
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDelete(session);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
