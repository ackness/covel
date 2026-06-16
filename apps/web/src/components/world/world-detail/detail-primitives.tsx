import i18n from "@/i18n/index.js";
import type { I18nText } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";

/**
 * Resolve an {@link I18nText} value to a display string for the active locale.
 *
 * Behaviour mirrors the historical local helper in world-detail-view: prefer an
 * exact language match, then a language-prefix match (`zh-CN` → `zh`), then the
 * first available value.
 */
export function text(v: I18nText | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  const lang = i18n.language;
  if (lang) {
    const r = v as Record<string, string>;
    if (r[lang]) return r[lang];
    const prefix = lang.split("-")[0];
    const fallback = Object.keys(r).find((k) => k.startsWith(prefix));
    if (fallback) return r[fallback];
  }
  return Object.values(v)[0] ?? "";
}

/** Translator function shared by every detail section. */
export type DetailTranslate = (k: string) => string;

/**
 * Compact card used by the Geography and Factions sections: a small title in
 * the header plus a muted-text content body. Callers supply both the title
 * region and the body so each section keeps its own field layout.
 */
export function DetailCard({
  title,
  children,
  contentClassName,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card>
      <CardHeader className="p-3 pb-1">{title}</CardHeader>
      <CardContent
        className={contentClassName ?? "p-3 pt-1 text-xs text-muted-foreground"}
      >
        {children}
      </CardContent>
    </Card>
  );
}

/** A title row with a small CardTitle — shared by DetailCard callers. */
export function DetailCardTitle({ children }: { children: React.ReactNode }) {
  return <CardTitle className="text-sm">{children}</CardTitle>;
}

/**
 * Render a horizontal wrap of outline badges from a list of i18n strings.
 * Used for traits, resources, themes, etc.
 */
export function BadgeList({
  items,
  variant = "outline",
  className,
}: {
  items: readonly I18nText[];
  variant?: "outline" | "secondary" | "default";
  /** Extra classes merged onto the wrapper (defaults to the flex-wrap row). */
  className?: string;
}) {
  return (
    <div
      className={
        className ? `${className} flex flex-wrap gap-1` : "flex flex-wrap gap-1"
      }
    >
      {items.map((item, i) => (
        <Badge key={i} variant={variant} className="text-xs">
          {text(item)}
        </Badge>
      ))}
    </div>
  );
}
