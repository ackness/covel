import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Flame, Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Eye, EyeOff, AlertTriangle, Sparkles, Shield,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";

// ── Types ────────────────────────────────────────────────────────

type EventStatus = "active" | "evolved" | "resolved" | "ended";
type EventVisibility = "visible" | "hidden" | "partial";

interface GameEvent {
  id: string;
  title: string;
  description?: string;
  type?: string;
  status: EventStatus;
  visibility?: EventVisibility;
  parentId?: string | null;
  tags?: string[];
  turnCreated?: number;
  turnResolved?: number;
}

// ── Status Config ────────────────────────────────────────────────

const STATUS_CONFIG: Record<EventStatus, {
  icon: typeof Flame;
  color: string;
  bg: string;
  label: string;
  labelZh: string;
}> = {
  active: {
    icon: Flame,
    color: "text-orange-500 dark:text-orange-400",
    bg: "bg-orange-500/10",
    label: "Active",
    labelZh: "进行中",
  },
  evolved: {
    icon: Sparkles,
    color: "text-purple-500 dark:text-purple-400",
    bg: "bg-purple-500/10",
    label: "Evolved",
    labelZh: "已演变",
  },
  resolved: {
    icon: CheckCircle2,
    color: "text-green-500 dark:text-green-400",
    bg: "bg-green-500/10",
    label: "Resolved",
    labelZh: "已解决",
  },
  ended: {
    icon: XCircle,
    color: "text-muted-foreground",
    bg: "bg-muted/30",
    label: "Ended",
    labelZh: "已结束",
  },
};

const VISIBILITY_ICON: Record<EventVisibility, typeof Eye> = {
  visible: Eye,
  hidden: EyeOff,
  partial: AlertTriangle,
};

// ── Component ────────────────────────────────────────────────────

interface EventPanelProps {
  gameState: Record<string, unknown>;
}

export function EventPanel({ gameState }: EventPanelProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [filter, setFilter] = useState<EventStatus | "all">("all");

  const events = extractEvents(gameState);

  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {isZh ? "暂无事件记录。" : "No events recorded yet."}
      </p>
    );
  }

  const filtered = filter === "all"
    ? events
    : events.filter((e) => e.status === filter);

  const rootEvents = filtered.filter((e) => !e.parentId);
  const childMap = buildChildMap(filtered);

  const statusCounts = countByStatus(events);

  return (
    <div className="space-y-3">
      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1">
        <FilterButton
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={isZh ? "全部" : "All"}
          count={events.length}
        />
        {(["active", "evolved", "resolved", "ended"] as const).map((s) => {
          const config = STATUS_CONFIG[s];
          return (
            <FilterButton
              key={s}
              active={filter === s}
              onClick={() => setFilter(s)}
              label={isZh ? config.labelZh : config.label}
              count={statusCounts[s] ?? 0}
            />
          );
        })}
      </div>

      {/* Event tree */}
      <div className="space-y-1.5">
        {rootEvents.map((event) => (
          <EventNode
            key={event.id}
            event={event}
            childMap={childMap}
            depth={0}
            isZh={isZh}
          />
        ))}
        {rootEvents.length === 0 && filtered.length > 0 && (
          // Orphan events (parentId set but parent filtered out)
          filtered.map((event) => (
            <EventNode
              key={event.id}
              event={event}
              childMap={childMap}
              depth={0}
              isZh={isZh}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── EventNode ────────────────────────────────────────────────────

interface EventNodeProps {
  event: GameEvent;
  childMap: Map<string, GameEvent[]>;
  depth: number;
  isZh: boolean;
}

function EventNode({ event, childMap, depth, isZh }: EventNodeProps) {
  const [expanded, setExpanded] = useState(event.status === "active" || event.status === "evolved");

  const config = STATUS_CONFIG[event.status] ?? STATUS_CONFIG.active;
  const Icon = config.icon;
  const children = childMap.get(event.id) ?? [];
  const hasChildren = children.length > 0;
  const hasDetail = Boolean(event.description) || (event.tags && event.tags.length > 0);

  const VisIcon = event.visibility ? VISIBILITY_ICON[event.visibility] : null;

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <Card className={`${config.bg} border-l-2 ${event.status === "active" ? "border-l-orange-500" : event.status === "evolved" ? "border-l-purple-500" : "border-l-border"}`}>
        <CardContent className="p-2.5 space-y-1.5">
          {/* Header */}
          <button
            type="button"
            className="w-full text-left flex items-center gap-2"
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${config.color}`} />
            <span className="text-xs font-medium flex-1 min-w-0 truncate">{event.title}</span>
            <Badge variant="outline" className={`text-[9px] rounded-none py-0 ${config.color}`}>
              {isZh ? config.labelZh : config.label}
            </Badge>
            {VisIcon && (
              <VisIcon className="w-3 h-3 text-muted-foreground shrink-0" />
            )}
            {(hasDetail || hasChildren) && (
              expanded
                ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
            )}
          </button>

          {/* Expanded detail */}
          {expanded && (
            <div className="space-y-1.5 pt-1 border-t border-border">
              {event.description && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">{event.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {event.type && (
                  <Badge variant="secondary" className="text-[9px] rounded-none py-0">{event.type}</Badge>
                )}
                {event.tags?.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[9px] rounded-none py-0">{tag}</Badge>
                ))}
                {event.turnCreated != null && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" /> T{event.turnCreated}
                    {event.turnResolved != null && `→T${event.turnResolved}`}
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Children */}
      {expanded && children.map((child) => (
        <EventNode
          key={child.id}
          event={child}
          childMap={childMap}
          depth={depth + 1}
          isZh={isZh}
        />
      ))}
    </div>
  );
}

// ── FilterButton ─────────────────────────────────────────────────

function FilterButton({ active, onClick, label, count }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:border-primary/50"
      }`}
    >
      {label}
      {count > 0 && <span className="ml-1 font-mono">({count})</span>}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function extractEvents(gameState: Record<string, unknown>): GameEvent[] {
  // Events can be stored in gameState.events (array or object map)
  const raw = gameState.events;
  if (!raw) return [];

  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];

  return list
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      id: String(e.id ?? ""),
      title: String(e.title ?? e.name ?? "Untitled"),
      description: e.description ? String(e.description) : undefined,
      type: e.type ? String(e.type) : undefined,
      status: (e.status as EventStatus) ?? "active",
      visibility: e.visibility as EventVisibility | undefined,
      parentId: e.parentId ? String(e.parentId) : null,
      tags: Array.isArray(e.tags) ? e.tags.map(String) : undefined,
      turnCreated: typeof e.turnCreated === "number" ? e.turnCreated : undefined,
      turnResolved: typeof e.turnResolved === "number" ? e.turnResolved : undefined,
    }));
}

function buildChildMap(events: GameEvent[]): Map<string, GameEvent[]> {
  const map = new Map<string, GameEvent[]>();
  for (const event of events) {
    if (event.parentId) {
      const siblings = map.get(event.parentId) ?? [];
      siblings.push(event);
      map.set(event.parentId, siblings);
    }
  }
  return map;
}

function countByStatus(events: GameEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.status] = (counts[event.status] ?? 0) + 1;
  }
  return counts;
}
