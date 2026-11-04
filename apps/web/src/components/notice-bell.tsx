import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  NOTICE_ICONS,
  NOTICE_ICON_CLASS,
  copyText,
} from "@/components/ui/notice-parts.js";
import { useDismissibleMenu } from "@/hooks/use-dismissible-menu.js";
import {
  restoreNotice,
  useNotices,
  type NoticeHistoryItem,
} from "@/lib/notice-center.js";
import { cn } from "@/lib/utils";

type Group = "session" | "all";

function timeLabel(at: number, locale: string): string {
  try {
    return new Date(at).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * The bell in the app bar: every card that is still open (including ones the
 * player collapsed) and the recent history of toasts and quiet failures.
 */
export function NoticeBell({ sessionId }: { readonly sessionId?: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<Group>(sessionId ? "session" : "all");
  const { containerRef, triggerRef } = useDismissibleMenu(open, setOpen, true);
  const cards = useNotices((state) => state.cards);
  const history = useNotices((state) => state.history);
  const unseen = cards.some((card) => card.changed);
  const effective: Group = sessionId ? group : "all";
  const rows = history
    .filter(
      (item) =>
        item.state !== "open" &&
        (effective === "all" || item.scope === sessionId),
    )
    .reverse();

  const openCard = (key: string) => {
    restoreNotice(key);
    setOpen(false);
    window.setTimeout(() => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-notice-key]",
      )) {
        if (element.dataset.noticeKey === key) {
          element.focus();
          break;
        }
      }
    }, 0);
  };

  const groupButton = (value: Group, label: string) => (
    <button
      type="button"
      aria-pressed={effective === value}
      onClick={() => setGroup(value)}
      className={cn(
        "rounded px-2 py-0.5 text-xs",
        effective === value
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      {label}
    </button>
  );

  return (
    <div ref={containerRef} className="relative" data-covel-host-controls="">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="relative h-10 w-10 text-muted-foreground hover:bg-muted/40 hover:text-primary rounded-(--radius-control) lg:h-9 lg:w-9"
        aria-label={
          cards.length > 0
            ? t("notice.bell.openCount", { count: cards.length })
            : t("notice.bell.title")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell className="h-4 w-4" />
        {cards.length > 0 && (
          <span
            data-testid="notice-bell-badge"
            className={cn(
              "absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground",
              unseen && "ring-2 ring-primary",
            )}
          >
            {cards.length}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label={t("notice.bell.title")}
          className="ui-dialog-shell absolute right-0 top-full z-60 mt-1.5 flex max-h-[min(32rem,70dvh)] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto p-3 text-sm"
        >
          {cards.length > 0 && (
            <section aria-label={t("notice.bell.open")}>
              <h2 className="mb-1 text-xs font-medium text-muted-foreground">
                {t("notice.bell.open")}
              </h2>
              <ul className="flex flex-col gap-1">
                {cards.map(({ notice, collapsed, changed }) => {
                  const Icon = NOTICE_ICONS[notice.tone];
                  return (
                    <li key={notice.key}>
                      <button
                        type="button"
                        onClick={() => openCard(notice.key)}
                        className="flex w-full items-start gap-2 rounded-(--radius-control) px-2 py-1.5 text-left hover:bg-muted/60"
                      >
                        <Icon
                          aria-hidden="true"
                          className={cn(
                            "mt-0.5 size-4 shrink-0",
                            NOTICE_ICON_CLASS[notice.tone],
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block wrap-break-word font-medium">
                            {notice.title}
                          </span>
                          {collapsed && (
                            <span className="block text-xs text-muted-foreground">
                              {changed
                                ? t("notice.bell.updated")
                                : t("notice.bell.hidden")}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section aria-label={t("notice.bell.history")}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">
                {t("notice.bell.history")}
              </h2>
              {sessionId && (
                <div className="flex gap-1">
                  {groupButton("session", t("notice.bell.thisGame"))}
                  {groupButton("all", t("notice.bell.all"))}
                </div>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t("notice.bell.empty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {rows.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    time={timeLabel(item.at, i18n.language)}
                    copyLabel={t("toast.copy", "Copy detail")}
                    resolvedLabel={t("notice.bell.resolved")}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  item,
  time,
  copyLabel,
  resolvedLabel,
}: {
  readonly item: NoticeHistoryItem;
  readonly time: string;
  readonly copyLabel: string;
  readonly resolvedLabel: string;
}) {
  const Icon = NOTICE_ICONS[item.tone];
  return (
    <li className="flex items-start gap-2 rounded-(--radius-control) px-2 py-1.5">
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", NOTICE_ICON_CLASS[item.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="wrap-break-word">{item.title}</p>
        {item.body && (
          <p className="wrap-break-word text-xs text-muted-foreground">
            {item.body}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {time}
          {item.state === "resolved" ? ` · ${resolvedLabel}` : ""}
        </p>
      </div>
      {item.detail && (
        <button
          type="button"
          onClick={() => void copyText(item.detail!)}
          title={copyLabel}
          aria-label={copyLabel}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </button>
      )}
    </li>
  );
}
