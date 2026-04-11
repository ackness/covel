import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen, Skull, Gem, MapPin, ScrollText, Users,
  Search, ChevronDown, ChevronRight, Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";

// ── Types ────────────────────────────────────────────────────────

type CodexCategory = "monster" | "item" | "location" | "lore" | "character" | "skill";

interface CodexEntry {
  id: string;
  title: string;
  category: CodexCategory;
  content?: string;
  tags?: string[];
  rarity?: string;
  isNew?: boolean;
  turnUnlocked?: number;
}

// ── Category Config ──────────────────────────────────────────────

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
    label: "Monsters",
    labelZh: "怪物",
  },
  item: {
    icon: Gem,
    color: "text-amber-500 dark:text-amber-400",
    bg: "bg-amber-500/10",
    label: "Items",
    labelZh: "物品",
  },
  location: {
    icon: MapPin,
    color: "text-blue-500 dark:text-blue-400",
    bg: "bg-blue-500/10",
    label: "Locations",
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
    label: "Characters",
    labelZh: "人物",
  },
  skill: {
    icon: Sparkles,
    color: "text-cyan-500 dark:text-cyan-400",
    bg: "bg-cyan-500/10",
    label: "Skills",
    labelZh: "技能",
  },
};

const ALL_CATEGORIES: CodexCategory[] = ["monster", "item", "location", "lore", "character", "skill"];

// ── Component ────────────────────────────────────────────────────

interface CodexPanelProps {
  gameState: Record<string, unknown>;
  /** Plugin data keyed by pluginId → namespace → key → value. */
  pluginData?: Record<string, Record<string, Record<string, unknown>>>;
}

export function CodexPanel({ gameState, pluginData }: CodexPanelProps) {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [categoryFilter, setCategoryFilter] = useState<CodexCategory | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const entries = extractCodexEntries(gameState, pluginData);

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {isZh ? "暂无图鉴收录。随着冒险探索，新发现将记录于此。" : "No codex entries yet. Discoveries will be recorded as you explore."}
      </p>
    );
  }

  const filtered = entries
    .filter((e) => categoryFilter === "all" || e.category === categoryFilter)
    .filter((e) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        e.title.toLowerCase().includes(q) ||
        e.content?.toLowerCase().includes(q) ||
        e.tags?.some((t) => t.toLowerCase().includes(q))
      );
    });

  const categoryCounts = countByCategory(entries);

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={isZh ? "搜索图鉴..." : "Search codex..."}
          className="w-full bg-background border border-border pl-7 pr-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-1">
        <CategoryButton
          active={categoryFilter === "all"}
          onClick={() => setCategoryFilter("all")}
          label={isZh ? "全部" : "All"}
          count={entries.length}
        />
        {ALL_CATEGORIES.map((cat) => {
          const config = CATEGORY_CONFIG[cat];
          const Icon = config.icon;
          return (
            <CategoryButton
              key={cat}
              active={categoryFilter === cat}
              onClick={() => setCategoryFilter(cat)}
              label={isZh ? config.labelZh : config.label}
              count={categoryCounts[cat] ?? 0}
              icon={<Icon className="w-3 h-3" />}
            />
          );
        })}
      </div>

      {/* Entry list */}
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {isZh ? "无匹配结果。" : "No matching entries."}
          </p>
        ) : (
          filtered.map((entry) => (
            <CodexEntryCard key={entry.id} entry={entry} isZh={isZh} />
          ))
        )}
      </div>

      {/* Summary */}
      <div className="text-[10px] text-muted-foreground text-center pt-1 border-t border-border">
        {isZh
          ? `共 ${entries.length} 条图鉴收录`
          : `${entries.length} entries collected`}
      </div>
    </div>
  );
}

// ── CodexEntryCard ───────────────────────────────────────────────

function CodexEntryCard({ entry, isZh }: { entry: CodexEntry; isZh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const config = CATEGORY_CONFIG[entry.category] ?? CATEGORY_CONFIG.lore;
  const Icon = config.icon;
  const hasDetail = Boolean(entry.content) || (entry.tags && entry.tags.length > 0);

  return (
    <Card className={`${config.bg} border-l-2 ${config.color.replace("text-", "border-l-").replace(" dark:text-", " dark:border-l-").split(" ")[0]}`}>
      <CardContent className="p-2.5 space-y-1.5">
        <button
          type="button"
          className="w-full text-left flex items-center gap-2"
          onClick={() => hasDetail && setExpanded((v) => !v)}
          disabled={!hasDetail}
        >
          <Icon className={`w-3.5 h-3.5 shrink-0 ${config.color}`} />
          <span className="text-xs font-medium flex-1 min-w-0 truncate">{entry.title}</span>
          {entry.isNew && (
            <Badge
              variant="outline"
              className="text-[9px] rounded-none py-0 bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
            >
              <Sparkles className="w-2.5 h-2.5 mr-0.5" />
              {isZh ? "新" : "NEW"}
            </Badge>
          )}
          <Badge variant="outline" className={`text-[9px] rounded-none py-0 ${config.color}`}>
            {isZh ? config.labelZh : config.label}
          </Badge>
          {hasDetail && (
            expanded
              ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )}
        </button>

        {expanded && (
          <div className="space-y-1.5 pt-1 border-t border-border">
            {entry.content && (
              <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.content}</p>
            )}
            {entry.tags && entry.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[9px] rounded-none py-0">{tag}</Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── CategoryButton ───────────────────────────────────────────────

function CategoryButton({ active, onClick, label, count, icon }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:border-primary/50"
      }`}
    >
      {icon}
      {label}
      {count > 0 && <span className="font-mono">({count})</span>}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract codex entries from plugin data (primary) or legacy gameState.codex (fallback).
 *
 * Plugin data source: any plugin that writes to the "entries" namespace is treated
 * as a codex data provider. The framework does NOT reference specific plugin IDs —
 * it discovers codex-like data by namespace convention.
 */
function extractCodexEntries(
  gameState: Record<string, unknown>,
  pluginData?: Record<string, Record<string, Record<string, unknown>>>,
): CodexEntry[] {
  const entries: CodexEntry[] = [];

  // Primary: read from pluginData — scan all plugins for "entries" namespace
  if (pluginData) {
    for (const [_pluginId, namespaces] of Object.entries(pluginData)) {
      const codexEntries = namespaces.entries;
      if (!codexEntries) continue;
      for (const [key, value] of Object.entries(codexEntries)) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Record<string, unknown>;
        entries.push({
          id: key,
          title: String(v.title ?? v.name ?? key),
          category: (v.category as CodexCategory) ?? "lore",
          content: v.content ? String(v.content) : undefined,
          tags: Array.isArray(v.tags) ? v.tags.map(String) : undefined,
          rarity: typeof v.rarity === "string" ? v.rarity : undefined,
          isNew: Boolean(v.isNew ?? v.newlyUnlocked),
        });
      }
    }
  }

  // Fallback: legacy gameState.codex (for backward compatibility)
  if (entries.length === 0) {
    const raw = gameState.codex;
    if (!raw) return [];

    let list: unknown[];
    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.entries)) {
        list = obj.entries;
      } else {
        list = Object.values(obj);
      }
    } else {
      return [];
    }

    for (const e of list) {
      if (typeof e !== "object" || e === null) continue;
      const v = e as Record<string, unknown>;
      entries.push({
        id: String(v.id ?? ""),
        title: String(v.title ?? v.name ?? "Untitled"),
        category: (v.category as CodexCategory) ?? "lore",
        content: v.content ? String(v.content) : undefined,
        tags: Array.isArray(v.tags) ? v.tags.map(String) : undefined,
        rarity: typeof v.rarity === "string" ? v.rarity : undefined,
        isNew: Boolean(v.isNew ?? v.newlyUnlocked),
      });
    }
  }

  return entries;
}

function countByCategory(entries: CodexEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  return counts;
}
