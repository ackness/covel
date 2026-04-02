import { ChevronRight } from "lucide-react";

export type SessionStep = "world_select" | "prep" | "game";

interface SessionBreadcrumbProps {
  step: SessionStep;
  worldName?: string;
  onGoWorldSelect?: () => void;
  onGoPrep?: () => void;
  disabled?: boolean;
}

const STEP_LABELS: Record<SessionStep, string> = {
  world_select: "选择世界",
  prep: "配置",
  game: "游戏中",
};

export function SessionBreadcrumb({
  step,
  worldName,
  onGoWorldSelect,
  onGoPrep,
  disabled,
}: SessionBreadcrumbProps) {
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
    <nav className="flex items-center gap-1 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3 h-3" />}
          {item.onClick ? (
            <button
              className="hover:text-primary transition-colors underline-offset-2 hover:underline"
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ) : (
            <span className={item.active ? "text-foreground font-medium" : ""}>
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
