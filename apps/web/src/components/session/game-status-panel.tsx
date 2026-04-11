import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MapPin, Clock, Cloud, Users, Target, Backpack, Swords, Brain,
  ChevronDown, ChevronRight, User, Shield, Heart, Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";

interface GameStatusPanelProps {
  gameState: Record<string, unknown>;
}

export function GameStatusPanel({ gameState }: GameStatusPanelProps) {
  const { t } = useTranslation();
  const isEmpty = Object.keys(gameState).length === 0;

  if (isEmpty) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noGameState")}
      </p>
    );
  }


  return (
    <div className="space-y-4">
      <WorldStateSection data={gameState.worldState} />
      {/* Characters are displayed in the dedicated "角色" tab — not duplicated here */}
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
  const { t } = useTranslation();
  if (!data || typeof data !== "object") return null;
  const ws = data as Record<string, unknown>;

  const location = ws.location as Record<string, unknown> | undefined;
  const time = ws.time as Record<string, unknown> | undefined;
  const weather = ws.weather as Record<string, unknown> | undefined;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <SectionHeader icon={MapPin} label={t("session.worldState")} />
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

const TYPE_STYLES: Record<string, string> = {
  player: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  npc: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  ally: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  enemy: "bg-red-500/15 text-red-500 dark:text-red-400 border-red-500/30",
};

function CharacterCard({ char }: { char: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);

  const name = String(char.name ?? "???");
  const type = char.type as string | undefined;
  const description = char.description as string | undefined;
  const traits = Array.isArray(char.traits) ? char.traits.map(String) : [];
  const status = char.status as string | undefined;
  const hp = char.hp as number | undefined;
  const maxHp = char.maxHp as number | undefined;
  const level = char.level as number | undefined;
  const role = char.role as string | undefined;
  const relationship = char.relationship as string | undefined;
  const location = char.location as string | undefined;

  // Collect extra fields not explicitly handled
  const handledKeys = new Set([
    "id", "name", "type", "description", "traits", "status",
    "hp", "maxHp", "level", "role", "relationship", "location",
    "worldId", "runId", "fields", "extensions", "createdAt", "version",
  ]);
  const extraEntries = Object.entries(char).filter(([k]) => !handledKeys.has(k));

  const hasDetail = description || traits.length > 0 || extraEntries.length > 0;

  return (
    <div className="border border-border">
      {/* Header — always visible */}
      <button
        type="button"
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
      >
        <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium flex-1 min-w-0 truncate">{name}</span>
        {level != null && (
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">Lv.{level}</span>
        )}
        {type && (
          <Badge variant="outline" className={`text-[9px] shrink-0 rounded-none ${TYPE_STYLES[type] ?? ""}`}>
            {type}
          </Badge>
        )}
        {status && (
          <Badge variant="secondary" className="text-[9px] shrink-0 rounded-none">
            {status}
          </Badge>
        )}
        {hasDetail && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
            : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Detail — expandable */}
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 space-y-2 border-t border-border bg-muted/10">
          {/* HP bar */}
          {hp != null && maxHp != null && maxHp > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> HP</span>
                <span className="font-mono">{hp}/{maxHp}</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${hp / maxHp > 0.5 ? "bg-green-500" : hp / maxHp > 0.25 ? "bg-yellow-500" : "bg-red-500"
                    }`}
                  style={{ width: `${Math.max(0, Math.min(100, (hp / maxHp) * 100))}%` }}
                />
              </div>
            </div>
          )}

          {/* Role / Relationship / Location */}
          {(role || relationship || location) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {role && (
                <span className="flex items-center gap-1">
                  <Shield className="w-3 h-3" /> {role}
                </span>
              )}
              {relationship && (
                <span className="flex items-center gap-1">
                  <Zap className="w-3 h-3" /> {relationship}
                </span>
              )}
              {location && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {location}
                </span>
              )}
            </div>
          )}

          {/* Description */}
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {description}
            </p>
          )}

          {/* Traits */}
          {traits.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {traits.map((trait) => (
                <Badge key={trait} variant="outline" className="text-[9px] rounded-none">
                  {trait}
                </Badge>
              ))}
            </div>
          )}

          {/* Extra fields */}
          {extraEntries.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-border">
              {extraEntries.map(([k, v]) => (
                <div key={k} className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{k}:</span>{" "}
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CharactersSection({ data }: { data: unknown }) {
  const { t } = useTranslation();
  if (!data) return null;
  const chars = Array.isArray(data)
    ? data
    : typeof data === "object"
      ? Object.entries(data as Record<string, unknown>).map(([key, val]) => {
          const obj = (typeof val === "object" && val !== null ? val : {}) as Record<string, unknown>;
          return obj.name ? obj : { ...obj, name: key };
        })
      : [];
  if (chars.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <SectionHeader icon={Users} label={t("session.characters")} />
        <div className="space-y-1">
          {chars.map((char, i) => {
            const c = char as Record<string, unknown>;
            return <CharacterCard key={String(c.id ?? i)} char={c} />;
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Quests ────────────────────────────────────────────────────────

function QuestsSection({ data }: { data: unknown }) {
  const { t } = useTranslation();
  if (!data) return null;
  const quests = Array.isArray(data) ? data : typeof data === "object" ? Object.values(data as Record<string, unknown>) : [];
  if (quests.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Target} label={t("session.quests")} />
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
              {!!quest.description && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">{String(quest.description)}</p>
              )}
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
  const { t } = useTranslation();
  if (!data || typeof data !== "object") return null;
  const inv = data as Record<string, unknown>;
  const items = Array.isArray(inv.items) ? inv.items : [];
  const currency = inv.currency as Record<string, unknown> | undefined;
  if (items.length === 0 && !currency) return null;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Backpack} label={t("session.inventory")} />
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
  const { t } = useTranslation();
  if (!data || typeof data !== "object") return null;
  const combat = data as Record<string, unknown>;
  if (!combat.active && !combat.participants) return null;

  const participants = Array.isArray(combat.participants) ? combat.participants : [];

  return (
    <Card className="border-destructive/30">
      <CardContent className="p-3 space-y-2">
        <SectionHeader icon={Swords} label={t("session.combat")} />
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
                    className={`h-full rounded-full transition-all ${hpPct > 50 ? "bg-green-500" : hpPct > 25 ? "bg-yellow-500" : "bg-red-500"
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
  const { t } = useTranslation();
  if (!data || typeof data !== "object") return null;
  const memory = data as Record<string, unknown>;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <SectionHeader icon={Brain} label={t("session.memoryArchive")} />
        {!!memory.summary && (
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{String(memory.summary)}</p>
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

// Only list framework-level state keys that are rendered by dedicated sections above.
// NEVER add plugin-specific IDs here — the framework must remain plugin-agnostic.
const KNOWN_KEYS = new Set(["worldState", "characters", "quests", "inventory", "combat", "memoryArchive", "characterFieldSchema", "characterSchema", "events", "state", "records", "path", "value", "scope", "patch"]);

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
