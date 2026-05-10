import { ChevronDown, ChevronUp } from "lucide-react";
import { CardHeader, CardTitle } from "@/components/ui/card.js";
import type { CollapsibleCardHeaderProps } from "./types.js";

export function CollapsibleCardHeader({
  expanded,
  onToggle,
  children,
  summary,
}: CollapsibleCardHeaderProps) {
  return (
    <CardHeader className="px-4 py-3 pb-2">
      <button
        className="w-full flex items-center justify-between text-left"
        onClick={onToggle}
      >
        <CardTitle className="flex items-center gap-2 text-sm">
          {children}
        </CardTitle>
        {expanded ? (
          <ChevronUp className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 shrink-0" />
        )}
      </button>
      {!expanded && summary && (
        <p className="text-xs text-muted-foreground mt-1.5">{summary}</p>
      )}
    </CardHeader>
  );
}
