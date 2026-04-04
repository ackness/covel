import { Badge } from "@/components/ui/badge.js";
import { BookOpen, Skull, Gem, MapPin, ScrollText, Users } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type CodexCategory = "monster" | "item" | "location" | "lore" | "character";

const CATEGORY_CONFIG: Record<CodexCategory, {
  icon: typeof BookOpen;
  color: string;
  bg: string;
  label: string;
  labelZh: string;
}> = {
  monster: {
    icon: Skull,
    color: "text-red-500 dark:text-red-400",
    bg: "bg-red-500/10",
    label: "Monster",
    labelZh: "怪物",
  },
  item: {
    icon: Gem,
    color: "text-amber-500 dark:text-amber-400",
    bg: "bg-amber-500/10",
    label: "Item",
    labelZh: "物品",
  },
  location: {
    icon: MapPin,
    color: "text-blue-500 dark:text-blue-400",
    bg: "bg-blue-500/10",
    label: "Location",
    labelZh: "地点",
  },
  lore: {
    icon: ScrollText,
    color: "text-purple-500 dark:text-purple-400",
    bg: "bg-purple-500/10",
    label: "Lore",
    labelZh: "传说",
  },
  character: {
    icon: Users,
    color: "text-green-500 dark:text-green-400",
    bg: "bg-green-500/10",
    label: "Character",
    labelZh: "人物",
  },
};

export function CodexEntryBlock({ data }: BlockRendererProps) {
  const action = (data.action as "unlock" | "update") ?? "unlock";
  const category = (data.category as CodexCategory) ?? "lore";
  const title = data.title as string | undefined;
  const content = data.content as string | undefined;
  const tags = (data.tags as string[]) ?? [];

  const config = CATEGORY_CONFIG[category] ?? CATEGORY_CONFIG.lore;
  const Icon = config.icon;

  const isUnlock = action === "unlock";

  return (
    <div className={`inline-flex items-start gap-3 border border-border px-4 py-3 max-w-md ${config.bg} animate-in fade-in duration-300`}>
      <div className={`flex h-8 w-8 items-center justify-center shrink-0 ${config.color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={`rounded-none text-[9px] uppercase tracking-widest py-0 ${
              isUnlock
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                : "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
            }`}
          >
            {isUnlock ? "NEW" : "UPDATE"}
          </Badge>
          <Badge
            variant="outline"
            className={`rounded-none text-[9px] uppercase tracking-widest py-0 ${config.color}`}
          >
            {config.label}
          </Badge>
        </div>
        {title && (
          <span className="text-sm font-medium">{title}</span>
        )}
        {content && (
          <p className="text-xs text-muted-foreground leading-relaxed">{content}</p>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="rounded-none text-[9px] py-0">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
