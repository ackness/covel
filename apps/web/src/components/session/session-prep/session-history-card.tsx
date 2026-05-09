import { History, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import type * as api from "@/services/api.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";

interface SessionHistoryCardProps {
  activeSessions: api.SessionRecord[];
  expanded: boolean;
  onToggle: () => void;
  onResume: (session: api.SessionRecord) => void;
  onRequestDelete: (session: api.SessionRecord) => void;
}

export function SessionHistoryCard({
  activeSessions,
  expanded,
  onToggle,
  onResume,
  onRequestDelete,
}: SessionHistoryCardProps) {
  const { t } = useTranslation();

  if (activeSessions.length === 0) return null;

  return (
    <Card className="mb-4">
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggle}
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
        <CardContent className="space-y-2">
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
                      {session.status} · t{session.turnCount}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(session.createdAt).toLocaleString("zh-CN")}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => onResume(session)}
                >
                  {t("session.resume")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-destructive h-8 w-8 p-0"
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
