import {
  MapPin, Clock, Cloud, Users, Target, Backpack, Swords, Brain,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";

interface GameStatusPanelProps {
  gameState: Record<string, unknown>;
}

export function GameStatusPanel({ gameState }: GameStatusPanelProps) {
  const isEmpty = Object.keys(gameState).length === 0;

  if (isEmpty) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No game state yet. State will appear as the story progresses.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <WorldStateSection data={gameState.worldState} />
      <CharactersSection data={gameState.characters} />
      <QuestsSection data={gameState.quests} />
      <InventorySection data={gameState.inventory} />
      <CombatSection data={gameState.combat} />
      <MemorySection data={gameState.memoryArchive} />
      <UnknownSections gameState={gameState} />
    </div>
  );
}

// ── Section Header ────────────────────────────────────────────────

function SectionHeader({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-2">
      <Icon className="w-3.5 h-3.5" />
      {label}
    </h4>
  );
}

// ── World State ───────────────────────────────────────────────────

function WorldStateSection({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const ws = data as Record<string, unknown>;

  const location = ws.location as Record<string, unknown> | undefined;
  const time = ws.time as Record<string, unknown> | undefined;
  const weather = ws.weather as Record<string, unknown> | undefined;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <SectionHeader icon={MapPin} label="World State" />
        {location && (
          <div className="flex items-center gap-1.5 text-xs">
            <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
            <span>{String(location.location ?? "")}</span>
            {!!location.subLocation && (
              <span className="text-muted-foreground">/ {String(location.subLocation)}</span>
            )}
          </div>
        )}
        {time && (
          <div className="flex items-center gap-1.5 text-xs">
            <Clock className="w-3 h-3 text-muted-foreground shrink-0" />
            <span>{String(time.period ?? time.time ?? "")}</span>
          </div>
        )}
        {weather && (
          <div className="flex items-center gap-1.5 text-xs">
            <Cloud className="w-3 h-3 text-muted-foreground shrink-0" />
            <span>{String(weather.weather ?? "")}</span>
            {!!weather.severity && (
              <span className="text-muted-foreground">({String(weather.severity)})</span>
            )}
          </div>
        )}
        {/* Render remaining top-level keys not already handled */}
        {Object.entries(ws)
          .filter(([k]) => !["location", "time", "weather"].includes(k))
          .map(([k, v]) => (
            <div key={k} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{k}:</span>{" "}
              {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

// ── Characters ────────────────────────────────────────────────────

function CharactersSection({ data }: { data: unknown }) {
  if (!data) return null;
  const chars = Array.isArray(data) ? data : typeof data === "object" ? Object.values(data as Record<string, unknown>) : [];
  if (chars.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Users} label="Characters" />
        {chars.map((char, i) => {
          const c = char as Record<string, unknown>;
          return (
            <div key={String(c.id ?? i)} className="flex items-start gap-2 text-xs">
              <span className="font-medium shrink-0">{String(c.name ?? "Unknown")}</span>
              {!!c.type && <Badge variant="outline" className="text-[9px] shrink-0">{String(c.type)}</Badge>}
              {!!c.description && <span className="text-muted-foreground truncate">{String(c.description)}</span>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Quests ────────────────────────────────────────────────────────

function QuestsSection({ data }: { data: unknown }) {
  if (!data) return null;
  const quests = Array.isArray(data) ? data : typeof data === "object" ? Object.values(data as Record<string, unknown>) : [];
  if (quests.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Target} label="Quests" />
        {quests.map((q, i) => {
          const quest = q as Record<string, unknown>;
          const objectives = Array.isArray(quest.objectives) ? quest.objectives : [];
          return (
            <div key={String(quest.id ?? i)} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">{String(quest.name ?? quest.title ?? "Quest")}</span>
                {!!quest.status && (
                  <Badge
                    variant={quest.status === "active" ? "default" : "secondary"}
                    className="text-[9px]"
                  >
                    {String(quest.status)}
                  </Badge>
                )}
              </div>
              {objectives.length > 0 && (
                <ul className="ml-4 space-y-0.5">
                  {objectives.map((obj, j) => {
                    const o = obj as Record<string, unknown>;
                    const done = Boolean(o.completed ?? o.done);
                    return (
                      <li key={j} className={`text-[11px] flex items-center gap-1 ${done ? "line-through text-muted-foreground" : ""}`}>
                        <span>{done ? "\u2713" : "\u25CB"}</span>
                        <span>{String(o.description ?? o.text ?? o.name ?? "")}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Inventory ─────────────────────────────────────────────────────

function InventorySection({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const inv = data as Record<string, unknown>;
  const items = Array.isArray(inv.items) ? inv.items : [];
  const currency = inv.currency as Record<string, unknown> | undefined;
  if (items.length === 0 && !currency) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Backpack} label="Inventory" />
        {items.map((item, i) => {
          const it = item as Record<string, unknown>;
          return (
            <div key={String(it.id ?? i)} className="flex items-center justify-between text-xs">
              <span>{String(it.name ?? "Item")}</span>
              {it.quantity != null && (
                <Badge variant="secondary" className="text-[9px]">x{String(it.quantity)}</Badge>
              )}
            </div>
          );
        })}
        {currency && (
          <div className="text-xs text-muted-foreground border-t border-border pt-1.5 mt-1.5">
            {Object.entries(currency).map(([k, v]) => (
              <span key={k} className="mr-3">
                <span className="font-medium text-foreground">{k}:</span> {String(v)}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Combat ────────────────────────────────────────────────────────

function CombatSection({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const combat = data as Record<string, unknown>;
  if (!combat.active && !combat.participants) return null;

  const participants = Array.isArray(combat.participants) ? combat.participants : [];

  return (
    <Card className="border-destructive/30">
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Swords} label="Combat" />
        {combat.round != null && (
          <div className="text-[11px] text-muted-foreground">
            Round {String(combat.round)}
            {!!combat.currentTurn && <span className="ml-2">Turn: {String(combat.currentTurn)}</span>}
          </div>
        )}
        {participants.map((p, i) => {
          const part = p as Record<string, unknown>;
          const hp = part.hp as number | undefined;
          const maxHp = part.maxHp as number | undefined;
          const hpPct = hp != null && maxHp ? Math.round((hp / maxHp) * 100) : null;
          return (
            <div key={String(part.id ?? i)} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{String(part.name ?? "???")}</span>
                {hp != null && <span className="text-muted-foreground">{String(hp)}{maxHp ? `/${String(maxHp)}` : ""} HP</span>}
              </div>
              {hpPct != null && (
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      hpPct > 50 ? "bg-green-500" : hpPct > 25 ? "bg-yellow-500" : "bg-red-500"
                    }`}
                    style={{ width: `${hpPct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Memory ────────────────────────────────────────────────────────

function MemorySection({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const memory = data as Record<string, unknown>;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <SectionHeader icon={Brain} label="Memory Archive" />
        {!!memory.summary && (
          <p className="text-xs text-muted-foreground leading-relaxed">{String(memory.summary)}</p>
        )}
        {memory.version != null && (
          <span className="text-[10px] text-muted-foreground">v{String(memory.version)}</span>
        )}
        {/* Render other keys */}
        {Object.entries(memory)
          .filter(([k]) => !["summary", "version"].includes(k))
          .map(([k, v]) => (
            <div key={k} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{k}:</span>{" "}
              {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

// ── Unknown Sections (catch-all for plugin data not handled above) ─

const KNOWN_KEYS = new Set(["worldState", "characters", "quests", "inventory", "combat", "memoryArchive"]);

function UnknownSections({ gameState }: { gameState: Record<string, unknown> }) {
  const unknownEntries = Object.entries(gameState).filter(([k]) => !KNOWN_KEYS.has(k));
  if (unknownEntries.length === 0) return null;

  return (
    <>
      {unknownEntries.map(([key, value]) => (
        <Card key={key}>
          <CardContent className="p-3 space-y-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {key}
            </h4>
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all font-mono">
              {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
            </pre>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
