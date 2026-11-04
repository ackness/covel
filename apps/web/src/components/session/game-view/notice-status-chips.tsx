import { useNotices } from "@/lib/notice-center.js";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  info: "text-foreground",
  success: "text-emerald-600",
  warning: "text-(--accent-warning)",
  error: "text-destructive",
} as const;

/**
 * Small text chips for state that is in progress (auto-advance, getting the
 * game ready). A chip with an action is a button that runs its first action.
 */
export function NoticeStatusChips({ scope }: { readonly scope?: string }) {
  const statuses = useNotices((state) =>
    state.statuses.filter(
      (status) => status.scope === "global" || status.scope === scope,
    ),
  );
  if (statuses.length === 0) return null;
  return (
    <>
      {statuses.map((status) => {
        const action = status.actions?.[0];
        const className = cn(
          "ui-chip inline-flex text-[10px]",
          TONE_CLASS[status.tone],
          action && "cursor-pointer hover:bg-muted/60",
        );
        const content = (
          <>
            <span className="ui-pulse-dot h-1.25 w-1.25 rounded-full bg-current" />
            {status.title}
          </>
        );
        return action ? (
          <button
            key={status.key}
            type="button"
            data-notice-key={status.key}
            data-testid={`notice-status-${status.key}`}
            className={className}
            title={action.label}
            onClick={action.onClick}
          >
            {content}
          </button>
        ) : (
          <span
            key={status.key}
            role="status"
            data-notice-key={status.key}
            data-testid={`notice-status-${status.key}`}
            className={className}
          >
            {content}
          </span>
        );
      })}
    </>
  );
}
