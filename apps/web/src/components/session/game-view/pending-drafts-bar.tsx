import { Check, X } from "lucide-react";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button.js";
import type { PendingInteractionDraft } from "@/stores/session-store.js";

interface PendingDraftsBarProps {
  t: TFunction;
  pendingDrafts: PendingInteractionDraft[];
  executing: boolean;
  onConfirmDrafts: () => void;
  onRemoveDraft: (id: string) => void;
}

export function PendingDraftsBar({
  t,
  pendingDrafts,
  executing,
  onConfirmDrafts,
  onRemoveDraft,
}: PendingDraftsBarProps) {
  if (pendingDrafts.length === 0) return null;

  return (
    <div
      className="px-3 md:px-4 py-2.5 border-t border-[var(--rule-color)] shrink-0 relative"
      style={{
        background:
          "color-mix(in oklab, var(--accent-primary) 4%, transparent)",
      }}
    >
      <div className="max-w-4xl mx-auto space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[11px] font-medium tabular-nums leading-none">
              {pendingDrafts.length}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {t("session.selectionsReady", {
                count: pendingDrafts.length,
              })}
            </span>
          </div>
          <Button
            size="sm"
            className="h-7 gap-1.5 shrink-0"
            disabled={executing}
            onClick={onConfirmDrafts}
          >
            <Check className="w-3.5 h-3.5" />
            {t("session.confirmSelections")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pendingDrafts.map((draft) => {
            const label = String(
              draft.values?.text ?? draft.label ?? "",
            ).trim();
            if (!label) return null;
            return (
              <span
                key={draft.id}
                className="group inline-flex items-start gap-1 max-w-full sm:max-w-[520px] rounded-[var(--radius-control)] border border-primary/20 bg-background pl-2 pr-0.5 py-1 text-[11px] leading-tight text-foreground shadow-sm"
              >
                <span
                  className="max-w-full overflow-hidden whitespace-normal [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                  title={label}
                >
                  {label}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveDraft(draft.id)}
                  className="inline-flex items-center justify-center h-6 w-6 -my-1 shrink-0 rounded-[var(--radius-control)] text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                  aria-label={t("session.removeDraft")}
                  title={t("session.removeDraft")}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
