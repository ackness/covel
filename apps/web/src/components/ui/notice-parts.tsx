import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  OctagonAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NoticeRecord, NoticeTone } from "@/lib/notice-center.js";

export const NOTICE_ICONS: Record<
  NoticeTone,
  ComponentType<{ className?: string }>
> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: OctagonAlert,
};

export const NOTICE_ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-primary",
  success: "text-emerald-500",
  warning: "text-amber-500",
  error: "text-destructive",
};

const ACCENT_CLASS: Record<NoticeTone, string> = {
  info: "border-l-primary",
  success: "border-l-emerald-500",
  warning: "border-l-amber-500",
  error: "border-l-destructive",
};

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard unavailable (insecure context, permissions): fall back to a
    // textarea selection. Best effort; the detail stays readable on screen.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // nothing else to try
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/** One look for toasts and cards: tone bar, icon, text, actions, close. */
export function NoticeView({
  notice,
  closeLabel,
  onClose,
  className,
  ...handlers
}: {
  readonly notice: NoticeRecord;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly className?: string;
  readonly onMouseEnter?: () => void;
  readonly onMouseLeave?: () => void;
  readonly onFocus?: () => void;
  readonly onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const Icon = NOTICE_ICONS[notice.tone];
  return (
    <section
      role={notice.tone === "error" ? "alert" : "status"}
      data-notice-key={notice.key}
      data-testid={`notice-${notice.key}`}
      data-notice-kind={notice.kind}
      data-notice-tone={notice.tone}
      tabIndex={-1}
      aria-label={notice.title}
      {...handlers}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-md border border-l-4 bg-background/90 px-3 py-2.5 text-foreground shadow-lg backdrop-blur-md",
        "animate-in fade-in slide-in-from-top-2",
        ACCENT_CLASS[notice.tone],
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", NOTICE_ICON_CLASS[notice.tone])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm leading-tight">
        <p className="wrap-break-word font-medium">{notice.title}</p>
        {notice.body ? (
          <p className="wrap-break-word whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
            {notice.body}
          </p>
        ) : null}
        {notice.render?.()}
        {notice.detail ? (
          <p className="wrap-break-word line-clamp-3 text-xs text-muted-foreground">
            {notice.detail}
          </p>
        ) : null}
        {notice.actions?.length ? (
          <div className="mt-1 flex flex-wrap gap-2">
            {notice.actions.map((action) => (
              <Button
                key={action.label}
                type="button"
                size="xs"
                variant={action.variant ?? "outline"}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {notice.detail ? (
          <button
            type="button"
            onClick={() => void copyText(notice.detail!)}
            title={t("toast.copy", "Copy detail")}
            aria-label={t("toast.copy", "Copy detail")}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
