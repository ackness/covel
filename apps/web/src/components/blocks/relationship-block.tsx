import { Badge } from "@/components/ui/badge.js";
import { Heart, Swords, Sparkles, GraduationCap, Skull, TrendingUp, TrendingDown } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type RelationshipType = "friend" | "rival" | "romantic" | "mentor" | "enemy";

const REL_CONFIG: Record<RelationshipType, {
  icon: typeof Heart;
  color: string;
  bg: string;
  label: string;
}> = {
  friend: { icon: Heart, color: "text-green-500 dark:text-green-400", bg: "bg-green-500/10", label: "Friend" },
  rival: { icon: Swords, color: "text-orange-500 dark:text-orange-400", bg: "bg-orange-500/10", label: "Rival" },
  romantic: { icon: Sparkles, color: "text-pink-500 dark:text-pink-400", bg: "bg-pink-500/10", label: "Romantic" },
  mentor: { icon: GraduationCap, color: "text-blue-500 dark:text-blue-400", bg: "bg-blue-500/10", label: "Mentor" },
  enemy: { icon: Skull, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", label: "Enemy" },
};

export function RelationshipBlock({ data }: BlockRendererProps) {
  const npcName = (data.npc_name as string) ?? "Unknown";
  const change = (data.change as number) ?? 0;
  const reason = data.reason as string | undefined;
  const newLevel = (data.new_level as number) ?? 50;
  const rank = data.rank as string | undefined;
  const relType = (data.relationship_type as RelationshipType) ?? "friend";

  const config = REL_CONFIG[relType] ?? REL_CONFIG.friend;
  const Icon = config.icon;
  const isPositive = change > 0;
  const pct = Math.max(0, Math.min(100, newLevel));

  return (
    <div className={`inline-flex items-start gap-3 border border-border ${config.bg} px-4 py-3 max-w-md`}>
      <div className={`flex h-8 w-8 items-center justify-center shrink-0 ${config.color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{npcName}</span>
          <Badge variant="outline" className={`rounded-none text-[9px] py-0 ${config.color}`}>
            {config.label}
          </Badge>
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
              className={`h-full rounded-full transition-all ${config.color.replace("text-", "bg-").split(" ")[0]}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{rank ?? `Level ${newLevel}`}</span>
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
