import { useState } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

export interface WorldDimensionSectionProps {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}

export function WorldDimensionSection({
  title,
  icon: Icon,
  children,
  defaultExpanded = false,
}: WorldDimensionSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex min-h-10 w-full items-center gap-2 rounded-(--radius-control) px-2 text-sm font-semibold transition-colors hover:bg-muted/40"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <Icon className="h-4 w-4" />
        <span>{title}</span>
      </button>

      {expanded && (
        <div className="border-l-2 border-border pl-4">{children}</div>
      )}
    </div>
  );
}
