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

  const items: Array<{ label: string; active: boolean; onClick?: () => void }> = [];

  // World select
  items.push({
    label: STEP_LABELS.world_select,
    active: step === "world_select",
    onClick: step !== "world_select" && !disabled ? onGoWorldSelect : undefined,
  });

  // Prep
  if (step === "prep" || step === "game") {
    items.push({
      label: worldName ?? STEP_LABELS.prep,
      active: step === "prep",
      onClick: step === "game" && !disabled ? onGoPrep : undefined,
    });
  }

  // Game
  if (step === "game") {
    items.push({
      label: STEP_LABELS.game,
      active: true,
    });
  }

  return (
    <nav className="flex items-center gap-1 text-xs text-muted-foreground paper:text-[13px] paper:gap-1.5">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1 paper:gap-1.5">
          {i > 0 && <ChevronRight className="w-3 h-3 paper:w-3 paper:h-3 paper:opacity-60" />}
          {item.onClick ? (
            <button
              className="hover:text-primary transition-colors underline-offset-2 hover:underline paper:hover:no-underline paper:hover:text-foreground"
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ) : (
            <span
              className={
                item.active
                  ? "text-foreground font-medium paper:font-normal paper:text-foreground"
                  : "paper:text-muted-foreground"
              }
            >
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
