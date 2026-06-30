import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import { resolveI18nText } from "@covel/shared";
import { useCharacterAttributeSchema } from "@/stores/plugin-data-store.js";
import { renderJsonValue } from "./core-renderers.js";
import { resolveIcon } from "./helpers.js";

// ── CharacterFieldsView ─────────────────────────────────────────
//
// Schema-aware renderer for a character's `fields` object. The
// world-data-provider plugin publishes the schema under the well-known
// `(*, 'schema', 'character-attributes')` path; the hook scans plugin ids so
// the catalog does not hardcode a provider.

type AttributeFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "map";
type CatId = "stats" | "bio" | "abilities" | "equipment" | "social";

interface AttrDefLite {
  readonly id: string;
  /** Plain string or i18n record (`{ "zh-CN": …, "en-US": … }`). */
  readonly name?: string | Readonly<Record<string, string>>;
  readonly type: AttributeFieldType;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly category: CatId;
  readonly defaultValue?: unknown;
  readonly subSchema?: readonly AttrDefLite[];
  readonly valueType?: "string" | "number" | "boolean";
}

const CATEGORY_ORDER: readonly CatId[] = [
  "bio",
  "stats",
  "abilities",
  "equipment",
  "social",
];

const CATEGORY_META: Record<CatId, { icon: string; tone: string }> = {
  stats: { icon: "heart", tone: "text-red-500 dark:text-red-400" },
  bio: { icon: "book-user", tone: "text-blue-500 dark:text-blue-400" },
  abilities: { icon: "swords", tone: "text-amber-500 dark:text-amber-400" },
  equipment: { icon: "backpack", tone: "text-green-500 dark:text-green-400" },
  social: { icon: "users", tone: "text-purple-500 dark:text-purple-400" },
};

function AttributeProgressBar({
  label,
  value,
  min,
  max,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
}) {
  const range = max - min;
  const isSignedRange = min < 0 && max > 0;
  const baselinePct =
    isSignedRange && range > 0
      ? Math.max(0, Math.min(100, ((0 - min) / range) * 100))
      : undefined;
  const pct =
    range > 0 ? Math.max(0, Math.min(100, ((value - min) / range) * 100)) : 0;
  const fillLeft = baselinePct === undefined ? 0 : Math.min(baselinePct, pct);
  const fillWidth =
    baselinePct === undefined ? pct : Math.max(0, Math.abs(pct - baselinePct));
  const valueLabel = isSignedRange
    ? value > 0
      ? `+${value}`
      : String(value)
    : `${value}/${max}`;
  const tone = isSignedRange
    ? value > 0
      ? "bg-emerald-500/80"
      : value < 0
        ? "bg-rose-500/80"
        : "bg-muted-foreground/35"
    : pct > 60
      ? "bg-emerald-500/80"
      : pct > 30
        ? "bg-amber-500/80"
        : "bg-rose-500/80";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground/70">{valueLabel}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={clsx(
            "absolute top-0 h-full transition-all duration-500",
            tone,
          )}
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />
        {baselinePct !== undefined && (
          <div
            className="absolute top-0 bottom-0 w-px bg-foreground/45"
            style={{ left: `${baselinePct}%` }}
          />
        )}
      </div>
    </div>
  );
}

function AttributeRow({ attr, value }: { attr: AttrDefLite; value: unknown }) {
  const { i18n } = useTranslation();
  const label = resolveI18nText(attr.name, i18n.language)?.trim() || attr.id;

  if (
    attr.type === "number" &&
    typeof value === "number" &&
    attr.max !== undefined
  ) {
    return (
      <AttributeProgressBar
        label={label}
        value={value}
        min={attr.min ?? 0}
        max={attr.max}
      />
    );
  }

  if (attr.type === "number" && typeof value === "number") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground/90">{value}</span>
      </div>
    );
  }

  if (attr.type === "enum" && typeof value === "string") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="ui-chip text-[10px] px-1.5 py-0.5 bg-muted text-foreground/80 border border-border/60">
          {value}
        </span>
      </div>
    );
  }

  if (attr.type === "array" && Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-muted-foreground/60 italic text-[10px]">—</span>
        </div>
      );
    }
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <span
              key={`${attr.id}-${i}`}
              className="ui-chip text-[10px] px-1.5 py-0.5 bg-muted text-foreground/80 border border-border/60"
            >
              {typeof item === "object" && item !== null
                ? JSON.stringify(item)
                : String(item)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (attr.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={value ? "text-emerald-500" : "text-muted-foreground/60"}
        >
          {value ? "✓" : "—"}
        </span>
      </div>
    );
  }

  // Object rows keep schema-known children first and render extras visibly.
  if (
    attr.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const nested = value as Record<string, unknown>;
    const subSchema = attr.subSchema ?? [];
    const subById = new Map<string, AttrDefLite>();
    for (const s of subSchema) subById.set(s.id, s);
    const extras = Object.keys(nested).filter((k) => !subById.has(k));
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="pl-3 border-l border-border/40 space-y-1">
          {subSchema.map((sub) => {
            const sv = nested[sub.id] ?? sub.defaultValue;
            if (sv === undefined) return null;
            return <AttributeRow key={sub.id} attr={sub} value={sv} />;
          })}
          {extras.map((k) => (
            <div key={k} className="text-[11px] leading-snug">
              <span className="font-mono text-muted-foreground">{k}</span>
              <span className="text-muted-foreground/60">: </span>
              {renderJsonValue(nested[k], 1)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Map rows render free-form keys with typed primitive values.
  if (
    attr.type === "map" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-muted-foreground/60 italic text-[10px]">—</span>
        </div>
      );
    }
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="pl-3 border-l border-border/40 space-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-2">
              <span className="font-mono text-muted-foreground shrink-0">
                {k}
              </span>
              <span className="text-foreground/90 text-right max-w-[60%] whitespace-pre-wrap">
                {v === null || v === undefined
                  ? "—"
                  : typeof v === "object"
                    ? JSON.stringify(v)
                    : String(v)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground/90 text-right max-w-[60%] whitespace-pre-wrap">
        {value === undefined || value === null || value === ""
          ? "—"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value)}
      </span>
    </div>
  );
}

export const CharacterFieldsView: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const raw = element.props?.value;
  const schema = useCharacterAttributeSchema() as {
    attributes?: readonly AttrDefLite[];
  } | null;

  const fields =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const attrs = schema?.attributes ?? [];
  const attrById = new Map<string, AttrDefLite>(attrs.map((a) => [a.id, a]));

  const groups = new Map<CatId, AttrDefLite[]>();
  for (const attr of attrs) {
    const hasValue = Object.prototype.hasOwnProperty.call(fields, attr.id);
    if (!hasValue && attr.defaultValue === undefined) continue;
    const cat = (
      CATEGORY_ORDER.includes(attr.category) ? attr.category : "bio"
    ) as CatId;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(attr);
  }

  const unknownKeys = Object.keys(fields).filter((k) => !attrById.has(k));

  const hasAnything = groups.size > 0 || unknownKeys.length > 0;
  if (!hasAnything) {
    return <div className="text-[11px]">{renderJsonValue(raw, 0)}</div>;
  }

  return (
    <div className="space-y-2.5">
      {CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => {
        const meta = CATEGORY_META[cat];
        const Icon = resolveIcon(meta.icon);
        return (
          <div key={cat} className="space-y-1">
            <div className={clsx("flex items-center gap-1.5", meta.tone)}>
              {Icon && <Icon className="h-3 w-3" />}
              <span className="text-[9px] font-semibold uppercase tracking-widest">
                {t(`character.categories.${cat}`, cat)}
              </span>
            </div>
            <div className="space-y-1 pl-0.5">
              {groups.get(cat)!.map((attr) => {
                const value = fields[attr.id] ?? attr.defaultValue;
                return <AttributeRow key={attr.id} attr={attr} value={value} />;
              })}
            </div>
          </div>
        );
      })}

      {unknownKeys.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-dashed border-border/40">
          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t("character.categories.custom", "Other")}
          </div>
          <div className="space-y-0.5">
            {unknownKeys.map((k) => (
              <div key={k} className="text-[11px] leading-snug">
                <span className="font-mono text-muted-foreground">{k}</span>
                <span className="text-muted-foreground/60">: </span>
                {renderJsonValue(fields[k], 1)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
