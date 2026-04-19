/**
 * Schema-driven character attribute panel.
 *
 * Reads the world's CharacterAttributeSchema to render structured attribute
 * groups (stats with progress bars, bio fields, enum badges, etc.) instead
 * of a single-line text description.
 *
 * Falls back to a simple key-value list when no schema is available.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { User, Shield, Swords, Heart, BookUser, Backpack, Users } from "lucide-react";
import type { AttributeCategory } from "@covel/shared";

// ── Types ─────────────────────────────────────────────────────

interface CharacterData {
  readonly id?: string;
  readonly name: string;
  readonly type?: string;
  readonly description?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Loose attribute definition — matches API JSON shape. */
interface AttrDef {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: unknown;
  readonly options?: readonly string[];
  readonly category: string;
  readonly description?: string;
}

interface SchemaData {
  readonly version?: number;
  readonly attributes?: readonly AttrDef[];
}

export interface CharacterPanelProps {
  characters: readonly Record<string, unknown>[];
  /** World character-attributes schema (from plugin_data or snapshot). */
  schema: SchemaData | Record<string, unknown> | null;
}

// ── Category config ─────────────────────────────────────────

const CATEGORY_META: Record<AttributeCategory, {
  icon: typeof Heart;
  color: string;
}> = {
  stats:     { icon: Heart,    color: "text-red-500 dark:text-red-400" },
  bio:       { icon: BookUser, color: "text-blue-500 dark:text-blue-400" },
  abilities: { icon: Swords,   color: "text-amber-500 dark:text-amber-400" },
  equipment: { icon: Backpack, color: "text-green-500 dark:text-green-400" },
  social:    { icon: Users,    color: "text-purple-500 dark:text-purple-400" },
};

const CATEGORY_ORDER: AttributeCategory[] = ["bio", "stats", "abilities", "equipment", "social"];

// ── Component ───────────────────────────────────────────────

export function CharacterPanel({ characters, schema }: CharacterPanelProps) {
  const { t } = useTranslation();

  if (characters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("character.noCharacters")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {characters.map((raw, idx) => {
        const char: CharacterData = {
          id: raw.id as string | undefined,
          name: (raw.name as string) ?? t("character.defaultName", { index: idx + 1 }),
          type: raw.type as string | undefined,
          description: raw.description as string | undefined,
          fields: raw.fields as Record<string, unknown> | undefined,
        };
        return (
          <CharacterCard
            key={char.id ?? char.name}
            character={char}
            schema={schema}
          />
        );
      })}
    </div>
  );
}

// ── Character Card ──────────────────────────────────────────

function CharacterCard({
  character,
  schema,
}: {
  character: CharacterData;
  schema: SchemaData | Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  const attrs = (schema as SchemaData | null)?.attributes;
  const fields = character.fields ?? {};

  // Group attributes by category
  const grouped = useMemo(() => {
    if (!attrs || attrs.length === 0) return null;

    const groups = new Map<string, Array<AttrDef & { value: unknown }>>();
    for (const attr of attrs) {
      const value = fields[attr.id];
      if (value === undefined && attr.defaultValue === undefined) continue;
      const cat = attr.category;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push({ ...attr, value: value ?? attr.defaultValue });
    }
    return groups;
  }, [attrs, fields]);

  const typeBadge = character.type === "player"
    ? t("character.type.player")
    : character.type === "npc"
      ? t("character.type.npc")
      : character.type;

  return (
    <Card>
      <CardHeader className="py-3 px-4 border-b border-border">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 shrink-0 text-muted-foreground" />
          <CardTitle className="text-sm font-bold flex-1">{character.name}</CardTitle>
          {typeBadge && (
            <Badge variant="outline" className="text-[10px] rounded-none uppercase tracking-widest">
              {typeBadge}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        {grouped ? (
          // Schema-driven rendering — show known categories in order, then any extras
          [...CATEGORY_ORDER.filter((cat) => grouped.has(cat)),
           ...Array.from(grouped.keys()).filter((cat) => !CATEGORY_ORDER.includes(cat as AttributeCategory))]
            .map((cat) => (
              <AttributeGroup
                key={cat}
                category={cat}
                attributes={grouped.get(cat)!}
              />
            ))
        ) : (
          // Fallback: simple key-value list from fields
          <FallbackFields fields={fields} description={character.description} />
        )}
      </CardContent>
    </Card>
  );
}

// ── Attribute Group ─────────────────────────────────────────

function AttributeGroup({
  category,
  attributes,
}: {
  category: string;
  attributes: Array<AttrDef & { value: unknown }>;
}) {
  const { t } = useTranslation();
  const meta = CATEGORY_META[category as AttributeCategory] ?? {
    icon: Shield,
    color: "text-muted-foreground",
  };
  const Icon = meta.icon;
  const label = CATEGORY_META[category as AttributeCategory]
    ? t(`character.categories.${category}`)
    : category;

  return (
    <div>
      <div className={`flex items-center gap-1.5 mb-1.5 ${meta.color}`}>
        <Icon className="h-3 w-3" />
        <span className="text-[10px] uppercase tracking-widest font-semibold">
          {label}
        </span>
      </div>
      <div className="space-y-1.5">
        {attributes.map((attr) => (
          <AttributeRow key={attr.id} attr={attr} />
        ))}
      </div>
    </div>
  );
}

// ── Attribute Row ───────────────────────────────────────────

function AttributeRow({ attr }: { attr: AttrDef & { value: unknown } }) {
  const { value } = attr;

  // Number with min/max → progress bar
  if (attr.type === "number" && attr.max !== undefined && typeof value === "number") {
    const min = attr.min ?? 0;
    const max = attr.max;
    const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;

    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground w-16 shrink-0 truncate" title={attr.name}>
          {attr.name}
        </span>
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary/70 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground w-14 text-right shrink-0">
          {value}/{max}
        </span>
      </div>
    );
  }

  // Number without max → simple value
  if (attr.type === "number" && typeof value === "number") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{attr.name}</span>
        <span className="font-mono text-xs font-medium">{value}</span>
      </div>
    );
  }

  // Enum → badge
  if (attr.type === "enum" && typeof value === "string") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{attr.name}</span>
        <Badge variant="outline" className="text-[10px] rounded-none">
          {value}
        </Badge>
      </div>
    );
  }

  // Array → comma-separated badges
  if (attr.type === "array" && Array.isArray(value)) {
    return (
      <div className="flex items-start gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0 mt-0.5">{attr.name}</span>
        <div className="flex flex-wrap gap-1">
          {(value as unknown[]).map((item, i) => (
            <Badge key={i} variant="outline" className="text-[10px] rounded-none">
              {String(item)}
            </Badge>
          ))}
        </div>
      </div>
    );
  }

  // Boolean → check/cross
  if (attr.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{attr.name}</span>
        <span className="text-xs">{value ? "✓" : "—"}</span>
      </div>
    );
  }

  // String / fallback
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">{attr.name}</span>
      <span className="text-xs font-medium truncate max-w-[60%] text-right">
        {value !== undefined && value !== null ? String(value) : "—"}
      </span>
    </div>
  );
}

// ── Fallback ────────────────────────────────────────────────

function FallbackFields({
  fields,
  description,
}: {
  fields: Readonly<Record<string, unknown>>;
  description?: string;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(fields).filter(
    ([k]) => k !== "_createCharacter" && k !== "characterName" && k !== "name",
  );

  if (entries.length === 0 && description) {
    return <p className="text-xs text-muted-foreground">{description}</p>;
  }

  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground italic">{t("character.noAttributes")}</p>;
  }

  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{k}</span>
          <span className="text-xs font-medium truncate max-w-[60%] text-right">
            {typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}
          </span>
        </div>
      ))}
    </div>
  );
}
