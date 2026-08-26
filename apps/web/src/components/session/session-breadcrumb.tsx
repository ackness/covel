import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export type SessionStep = "world_select" | "prep" | "game";

interface SessionBreadcrumbProps {
  step: SessionStep;
  worldName?: string;
  onGoWorldSelect?: () => void;
  onGoPrep?: () => void;
  disabled?: boolean;
}

export function SessionBreadcrumb({
  step,
  worldName,
  onGoWorldSelect,
  onGoPrep,
  disabled,
}: SessionBreadcrumbProps) {
  const { t } = useTranslation();

  const STEP_LABELS: Record<SessionStep, string> = {
    world_select: t("session.breadcrumbWorldSelect"),
    prep: t("session.breadcrumbPrep"),
    game: t("session.breadcrumbGame"),
  };

  type Item = { label: string; active: boolean; onClick?: () => void };
  const items: Item[] = [];

  items.push({
    label: STEP_LABELS.world_select,
    active: step === "world_select",
    onClick: step !== "world_select" && !disabled ? onGoWorldSelect : undefined,
  });

  if (step === "prep" || step === "game") {
    items.push({
      label: worldName ?? STEP_LABELS.prep,
      active: step === "prep",
      onClick: step === "game" && !disabled ? onGoPrep : undefined,
    });
  }

  if (step === "game") {
    items.push({
      label: STEP_LABELS.game,
      active: true,
    });
  }

  // The breadcrumb sits inside narrow flex containers (chat header), so
  // both the wrapping nav AND each cell must enforce nowrap or CJK content
  // wraps character-by-character into a vertical column.
  return (
    <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 max-w-full overflow-hidden whitespace-nowrap">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        // At narrow widths, hide all intermediate steps so the active node
        // (and only the active node) stays readable.
        const intermediate = !isLast && i > 0;
        return (
          <span
            key={i}
            className={`flex items-center gap-1.5 min-w-0 whitespace-nowrap ${
              intermediate ? "hidden lg:inline-flex" : ""
            } ${i === 0 && step === "game" ? "hidden md:inline-flex" : ""}`}
          >
            {i > 0 && (
              <ChevronRight
                className={`w-3 h-3 opacity-60 shrink-0 ${
                  i === 1 && step === "game" ? "hidden md:inline-block" : ""
                }`}
              />
            )}
            {item.onClick ? (
              <button
                className="hover:text-primary transition-colors underline-offset-2 hover:underline truncate max-w-56"
                onClick={item.onClick}
              >
                {item.label}
              </button>
            ) : (
              <span
                className={`truncate max-w-56 ${
                  item.active ? "text-foreground font-medium" : ""
                }`}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
