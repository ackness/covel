import { Badge } from "@/components/ui/badge.js";
import { Flag, TrendingUp, TrendingDown } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

export function ReputationBlock({ data }: BlockRendererProps) {
  const faction = (data.faction as string) ?? "Unknown Faction";
  const change = (data.change as number) ?? 0;
  const reason = data.reason as string | undefined;
  const newStanding = (data.new_standing as number) ?? 50;
  const rank = data.rank as string | undefined;

  const isPositive = change > 0;
  const pct = Math.max(0, Math.min(100, newStanding));

  // Color based on standing
  const standingColor = pct >= 75
    ? "text-green-500 dark:text-green-400"
    : pct >= 50
      ? "text-blue-500 dark:text-blue-400"
      : pct >= 25
        ? "text-amber-500 dark:text-amber-400"
        : "text-red-500 dark:text-red-400";

  const barColor = pct >= 75
    ? "bg-green-500"
    : pct >= 50
      ? "bg-blue-500"
      : pct >= 25
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="inline-flex items-start gap-3 border border-border bg-muted/20 px-4 py-3 max-w-md">
      <div className={`flex h-8 w-8 items-center justify-center shrink-0 ${standingColor}`}>
        <Flag className="h-5 w-5" />
      </div>
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{faction}</span>
          {change !== 0 && (
            <Badge
              variant="outline"
              className={`rounded-none text-[9px] py-0 ml-auto ${
                isPositive ? "text-green-500 border-green-500/30" : "text-red-500 border-red-500/30"
              }`}
            >
              {isPositive ? <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> : <TrendingDown className="h-2.5 w-2.5 mr-0.5" />}
              {isPositive ? "+" : ""}{change}
            </Badge>
          )}
        </div>

        {/* Progress bar */}
        <div className="space-y-0.5">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{rank ?? "Neutral"}</span>
            <span className="font-mono">{pct}%</span>
          </div>
        </div>

        {reason && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">{reason}</p>
        )}
      </div>
    </div>
  );
}
