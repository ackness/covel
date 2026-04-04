import { Badge } from "@/components/ui/badge.js";
import { Sparkles, ShieldOff, Flame, Heart, Plus, Minus } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type EffectType = "buff" | "debuff" | "dot" | "hot";
type EffectAction = "apply" | "remove" | "tick";

const EFFECT_CONFIG: Record<EffectType, {
  icon: typeof Sparkles;
  color: string;
  bg: string;
}> = {
  buff: { icon: Sparkles, color: "text-green-500 dark:text-green-400", bg: "bg-green-500/10" },
  debuff: { icon: ShieldOff, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10" },
  dot: { icon: Flame, color: "text-orange-500 dark:text-orange-400", bg: "bg-orange-500/10" },
  hot: { icon: Heart, color: "text-pink-500 dark:text-pink-400", bg: "bg-pink-500/10" },
};

const ACTION_ICON: Record<EffectAction, typeof Plus> = {
  apply: Plus,
  remove: Minus,
  tick: Flame,
};

export function StatusEffectBlock({ data }: BlockRendererProps) {
  const action = (data.action as EffectAction) ?? "apply";
  const effectName = (data.effect_name as string) ?? "Unknown";
  const effectType = (data.effect_type as EffectType) ?? "buff";
  const duration = data.duration as number | undefined;
  const target = data.target as string | undefined;
  const stats = data.stats as Record<string, number> | undefined;
  const damagePerTurn = data.damage_per_turn as number | undefined;
  const healPerTurn = data.heal_per_turn as number | undefined;
  const description = data.description as string | undefined;

  const config = EFFECT_CONFIG[effectType] ?? EFFECT_CONFIG.buff;
  const Icon = config.icon;
  const ActionIcon = ACTION_ICON[action] ?? ACTION_ICON.apply;

  const isRemove = action === "remove";

  return (
    <div className={`inline-flex items-start gap-3 border border-border ${config.bg} px-4 py-3 max-w-md ${isRemove ? "opacity-70" : ""}`}>
      <div className={`flex h-8 w-8 items-center justify-center shrink-0 ${config.color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={`rounded-none text-[9px] uppercase tracking-widest py-0 ${config.color}`}
          >
            <ActionIcon className="h-2.5 w-2.5 mr-0.5" />
            {action === "apply" ? "Applied" : action === "remove" ? "Removed" : "Tick"}
          </Badge>
          <span className={`text-xs font-medium ${config.color}`}>{effectName}</span>
        </div>

        {target && (
          <span className="text-[11px] text-muted-foreground">Target: {target}</span>
        )}

        {description && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {duration != null && (
            <span className="text-[10px] text-muted-foreground">
              Duration: <span className="font-mono">{duration}</span> turns
            </span>
          )}
          {damagePerTurn != null && (
            <span className="text-[10px] text-red-500">
              {damagePerTurn} dmg/turn
            </span>
          )}
          {healPerTurn != null && (
            <span className="text-[10px] text-green-500">
              +{healPerTurn} heal/turn
            </span>
          )}
        </div>

        {stats && Object.keys(stats).length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-border mt-0.5">
            {Object.entries(stats).map(([stat, val]) => (
              <Badge key={stat} variant="secondary" className="text-[9px] rounded-none py-0">
                {stat}: <span className={val > 0 ? "text-green-500" : "text-red-500"}>
                  {val > 0 ? "+" : ""}{val}
                </span>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
