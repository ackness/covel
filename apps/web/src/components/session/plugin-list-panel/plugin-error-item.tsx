import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import type { PluginErrorItemProps } from "./types.js";

export function PluginErrorItem({ error }: PluginErrorItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-destructive/40 bg-destructive/5 rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-destructive/10 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-destructive transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-destructive" />
        <span className="text-xs font-medium truncate flex-1 text-destructive">
          {error.pluginId}
        </span>
        <Badge
          variant="destructive"
          className="text-[9px] px-1.5 py-0 h-4 shrink-0"
        >
          Error
        </Badge>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 pt-1 border-t border-destructive/20">
          <ul className="space-y-0.5">
            {error.errors.map((msg, i) => (
              <li key={i} className="text-[10px] text-destructive/80 font-mono">
                • {msg}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
