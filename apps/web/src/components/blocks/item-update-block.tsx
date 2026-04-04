import { Badge } from "@/components/ui/badge.js";
import { ArrowUp, ArrowDown, Hand, Shield, CircleOff } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type ItemAction = "gain" | "lose" | "use" | "equip" | "unequip";

interface ItemUpdate {
  action: ItemAction;
  item_name: string;
  quantity?: number;
  item_type?: string;
  description?: string;
  stats?: Record<string, number>;
}

const ACTION_CONFIG: Record<ItemAction, {
  icon: typeof ArrowUp;
  color: string;
  bg: string;
  label: string;
}> = {
  gain: { icon: ArrowUp, color: "text-green-600 dark:text-green-400", bg: "bg-green-500/10", label: "Gained" },
  lose: { icon: ArrowDown, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", label: "Lost" },
  use: { icon: Hand, color: "text-blue-500 dark:text-blue-400", bg: "bg-blue-500/10", label: "Used" },
  equip: { icon: Shield, color: "text-amber-500 dark:text-amber-400", bg: "bg-amber-500/10", label: "Equipped" },
  unequip: { icon: CircleOff, color: "text-muted-foreground", bg: "bg-muted/30", label: "Unequipped" },
};

export function ItemUpdateBlock({ data }: BlockRendererProps) {
  // Support single item or batch
  const items: ItemUpdate[] = Array.isArray(data.items)
    ? (data.items as ItemUpdate[])
    : [{
        action: (data.action as ItemAction) ?? "gain",
        item_name: (data.item_name as string) ?? "Unknown",
        quantity: data.quantity as number | undefined,
        item_type: data.item_type as string | undefined,
        description: data.description as string | undefined,
        stats: data.stats as Record<string, number> | undefined,
      }];

  return (
    <div className="space-y-1 max-w-md">
      {items.map((item, i) => {
        const config = ACTION_CONFIG[item.action] ?? ACTION_CONFIG.gain;
        const Icon = config.icon;

        return (
          <div key={i} className={`inline-flex items-center gap-2.5 border border-border ${config.bg} px-3 py-2 w-full`}>
            <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${config.color}`}>{item.item_name}</span>
                {item.quantity != null && item.quantity > 1 && (
                  <span className="text-[10px] text-muted-foreground">x{item.quantity}</span>
                )}
                <Badge variant="outline" className={`text-[9px] rounded-none py-0 ml-auto ${config.color}`}>
                  {config.label}
                </Badge>
              </div>
              {item.description && (
                <p className="text-[11px] text-muted-foreground mt-0.5">{item.description}</p>
              )}
              {item.stats && Object.keys(item.stats).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {Object.entries(item.stats).map(([stat, val]) => (
                    <span key={stat} className="text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground">{stat}:</span>{" "}
                      <span className={val > 0 ? "text-green-500" : val < 0 ? "text-red-500" : ""}>
                        {val > 0 ? "+" : ""}{val}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
