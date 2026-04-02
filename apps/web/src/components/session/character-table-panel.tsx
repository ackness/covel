import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown, ChevronRight, User, Heart,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";

// ── Types ────────────────────────────────────────────────────────

interface FieldDefinition {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "enum" | "text";
  options?: string[];
  defaultValue?: unknown;
  category?: "stats" | "bio" | "equipment" | "social" | "custom";
  visible?: boolean;
  min?: number;
  max?: number;
}

interface DynamicFieldSchema {
  version: number;
  worldId: string;
  fields: FieldDefinition[];
  createdAt: string;
}

interface CharacterTablePanelProps {
  schema: DynamicFieldSchema;
  characters: Record<string, unknown>[];
}

// ── Category config ──────────────────────────────────────────────

const CATEGORY_ORDER: readonly string[] = ["stats", "bio", "equipment", "social", "custom"];

const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  stats:     { zh: "属性", en: "Stats" },
  bio:       { zh: "背景", en: "Bio" },
  equipment: { zh: "装备", en: "Equipment" },
  social:    { zh: "社交", en: "Social" },
  custom:    { zh: "其他", en: "Other" },
};

const TYPE_BADGE_STYLES: Record<string, string> = {
  player:    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  companion: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  npc:       "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  ally:      "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  enemy:     "bg-red-500/15 text-red-500 dark:text-red-400 border-red-500/30",
};

// ── Helpers ──────────────────────────────────────────────────────

function groupFieldsByCategory(fields: FieldDefinition[]): Map<string, FieldDefinition[]> {
  const groups = new Map<string, FieldDefinition[]>();
  for (const f of fields) {
    if (f.visible === false) continue;
    const cat = f.category ?? "custom";
    const list = groups.get(cat) ?? [];
    list.push(f);
    groups.set(cat, list);
  }
  return groups;
}

// ── Field Renderers ──────────────────────────────────────────────

function NumberBar({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  const range = max - min;
  const pct = range > 0 ? Math.max(0, Math.min(100, ((value - min) / range) * 100)) : 100;
  const color = pct > 50 ? "bg-green-500" : pct > 25 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{label}</span>
        <span className="font-mono">{value}/{max}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FieldValue({ def, value }: { def: FieldDefinition; value: unknown }) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground/50">--</span>;
  }

  // Number with min/max → progress bar
  if (def.type === "number" && def.min !== undefined && def.max !== undefined) {
    return <NumberBar value={Number(value)} min={def.min} max={def.max} label={def.label} />;
  }

  // Number without range
  if (def.type === "number") {
    return <span className="font-mono text-xs">{String(value)}</span>;
  }

  // Enum → colored badge
  if (def.type === "enum") {
    return (
      <Badge variant="outline" className="text-[9px] rounded-none">
        {String(value)}
      </Badge>
    );
  }

  // Boolean → badge
  if (def.type === "boolean") {
    return (
      <Badge variant={value ? "default" : "secondary"} className="text-[9px] rounded-none">
        {value ? "Yes" : "No"}
      </Badge>
    );
  }

  // Text → multi-line
  if (def.type === "text") {
    return <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{String(value)}</p>;
  }

  // String default
  return <span className="text-xs">{String(value)}</span>;
}

// ── Character Row ────────────────────────────────────────────────

function SchemaCharacterCard({
  char,
  fieldGroups,
  isZh,
}: {
  char: Record<string, unknown>;
  fieldGroups: Map<string, FieldDefinition[]>;
  isZh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const name = String(char.name ?? "???");
  const type = char.type as string | undefined;
  const description = char.description as string | undefined;
  const fields = (char.fields ?? {}) as Record<string, unknown>;

  // Quick stats summary (first 3 visible "stats" fields)
  const statsFields = fieldGroups.get("stats") ?? [];
  const quickStats = statsFields.slice(0, 3);

  return (
    <div className="border border-border">
      {/* Header */}
      <button
        type="button"
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium flex-1 min-w-0 truncate">{name}</span>

        {/* Quick stat badges */}
        {!expanded && quickStats.map((def) => {
          const val = fields[def.key];
          if (val === undefined || val === null) return null;
          return (
            <span key={def.key} className="text-[10px] font-mono text-muted-foreground shrink-0">
              {def.label}: {String(val)}
            </span>
          );
        })}

        {type && (
          <Badge variant="outline" className={`text-[9px] shrink-0 rounded-none ${TYPE_BADGE_STYLES[type] ?? ""}`}>
            {type}
          </Badge>
        )}
        {expanded
          ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        }
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border bg-muted/10">
          {/* Description */}
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {description}
            </p>
          )}

          {/* Fields grouped by category */}
          {CATEGORY_ORDER.map((cat) => {
            const defs = fieldGroups.get(cat);
            if (!defs || defs.length === 0) return null;
            const catLabel = CATEGORY_LABELS[cat];
            return (
              <div key={cat} className="space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {isZh ? catLabel?.zh : catLabel?.en}
                </div>
                <div className="space-y-1">
                  {defs.map((def) => {
                    const val = fields[def.key];
                    // Number bars render full-width
                    if (def.type === "number" && def.min !== undefined && def.max !== undefined && val != null) {
                      return (
                        <div key={def.key}>
                          <NumberBar value={Number(val)} min={def.min} max={def.max} label={def.label} />
                        </div>
                      );
                    }
                    // Text fields render full-width
                    if (def.type === "text" && val != null) {
                      return (
                        <div key={def.key} className="space-y-0.5">
                          <span className="text-[10px] text-muted-foreground">{def.label}</span>
                          <FieldValue def={def} value={val} />
                        </div>
                      );
                    }
                    // Inline key-value
                    return (
                      <div key={def.key} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{def.label}</span>
                        <FieldValue def={def} value={val} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────

export function CharacterTablePanel({ schema, characters }: CharacterTablePanelProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");

  if (characters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noCharacters")}
      </p>
    );
  }

  const fieldGroups = groupFieldsByCategory(schema.fields);

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-2">
          <User className="w-3.5 h-3.5" />
          {t("session.characters")}
        </h4>
        <div className="space-y-1">
          {characters.map((char, i) => (
            <SchemaCharacterCard
              key={String(char.id ?? char.name ?? i)}
              char={char}
              fieldGroups={fieldGroups}
              isZh={isZh}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
