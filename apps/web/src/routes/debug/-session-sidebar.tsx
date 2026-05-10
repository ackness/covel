import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { fmtTime } from "./-debug-helpers.js";
import type { DebugPageData } from "./-debug-page-data.js";

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
    <div className="w-56 flex-shrink-0 border-r border-[var(--rule-color)] flex flex-col min-h-0 ui-rail">
      <div className="px-3 py-2 border-b border-[var(--rule-color)]">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.sessions")}
        </h2>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 space-y-0.5">
          {sessions.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic px-2 py-3">
              {t("debugger.noSessions")}
            </p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`w-full text-left px-2.5 py-2 text-[11px] border transition-colors ${
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
                <span className="font-mono truncate text-[10px]">
                  {session.id}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="text-[9px] h-4 px-1">
                  {session.status} · t{session.turnCount}
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
      </ScrollArea>
    </div>
  );
}
