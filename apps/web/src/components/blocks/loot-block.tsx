import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Package, Coins } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

interface LootItem {
  name: string;
  type?: string;
  quantity?: number;
  rarity?: Rarity;
  description?: string;
}

const RARITY_STYLES: Record<Rarity, { color: string; bg: string; border: string }> = {
  common: { color: "text-muted-foreground", bg: "bg-muted/30", border: "border-border" },
  uncommon: { color: "text-green-600 dark:text-green-400", bg: "bg-green-500/10", border: "border-green-500/30" },
  rare: { color: "text-blue-500 dark:text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/30" },
  epic: { color: "text-purple-500 dark:text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
  legendary: { color: "text-amber-500 dark:text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
};

export function LootBlock({ data }: BlockRendererProps) {
  const source = data.source as string | undefined;
  const items = (data.items as LootItem[]) ?? [];
  const gold = data.gold as number | undefined;

  return (
    <Card className="max-w-md bg-amber-500/5 border-amber-500/20">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-amber-500" />
          <span className="text-[10px] uppercase tracking-widest text-amber-600 dark:text-amber-400 font-semibold">
            Loot
          </span>
          {source && (
            <span className="text-[10px] text-muted-foreground ml-auto">{source}</span>
          )}
        </div>

        {items.map((item, i) => {
          const rarity = item.rarity ?? "common";
          const styles = RARITY_STYLES[rarity] ?? RARITY_STYLES.common;

          return (
            <div key={i} className={`flex items-center gap-2 border ${styles.border} ${styles.bg} px-3 py-2`}>
              <span className={`text-xs font-medium flex-1 min-w-0 ${styles.color}`}>
                {item.name}
              </span>
              {item.quantity != null && item.quantity > 1 && (
                <Badge variant="secondary" className="text-[9px] rounded-none py-0">
                  x{item.quantity}
                </Badge>
              )}
              {item.type && (
                <Badge variant="outline" className="text-[9px] rounded-none py-0">
                  {item.type}
                </Badge>
              )}
              <Badge variant="outline" className={`text-[9px] rounded-none py-0 ${styles.color}`}>
                {rarity}
              </Badge>
            </div>
          );
        })}

        {gold != null && gold > 0 && (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 border-t border-border pt-2">
            <Coins className="h-3.5 w-3.5" />
            <span className="font-medium">{gold} Gold</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
