import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { fmtTime } from "./-debug-helpers.js";
import type { DebugPageData } from "./-debug-page-data.js";
import { sessionStatusLabel, sessionTurnLabel } from "@/lib/session-display.js";

export function SessionSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
}: {
  sessions: DebugPageData["sessions"];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="h-28 w-full shrink-0 border-b border-(--rule-color) flex flex-col min-h-0 ui-rail sm:h-auto sm:w-56 sm:border-b-0 sm:border-r">
      <div className="px-3 py-2 border-b border-(--rule-color)">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.sessions")}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="p-1.5 space-y-0.5">
          {sessions.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-2 py-3">
              {t("debugger.noSessions")}
            </p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              aria-current={
                selectedSessionId === session.id ? "page" : undefined
              }
              className={`w-full text-left px-2.5 py-2 text-xs border transition-colors ${
                selectedSessionId === session.id
                  ? "border-primary/40 bg-primary/5 text-foreground"
                  : "border-transparent hover:border-border hover:bg-muted/20 text-muted-foreground"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${
                    session.status === "active"
                      ? "bg-emerald-500"
                      : "bg-zinc-400"
                  }`}
                />
                <span className="font-mono truncate text-xs">{session.id}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-xs h-4 px-1">
                  {sessionStatusLabel(t, session.status)} ·{" "}
                  {sessionTurnLabel(t, session.completedPlayerTurns)}
                </Badge>
                <span title={session.createdAt}>
                  {fmtTime(session.createdAt, {
                    withMillis: false,
                    alwaysDate: true,
                  })}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
