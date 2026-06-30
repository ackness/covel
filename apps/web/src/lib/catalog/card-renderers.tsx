import { Children, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import { resolveIcon, useI18nResolver } from "./helpers.js";
import { useCollapsible } from "./use-collapsible.js";
import {
  categoryIconColors,
  categoryIcons,
  rarityBadgeColors,
  rarityMarkerColor,
  rarityTone,
} from "./catalog-constants.js";

export const Card: ComponentRenderer = ({ element, children }) => {
  const variant = element.props?.variant as string;
  const collapsible = (element.props?.collapsible as boolean) ?? false;
  const defaultExpanded = (element.props?.defaultExpanded as boolean) ?? false;
  const { expanded, toggle } = useCollapsible(defaultExpanded);

  let body: ReactNode = children;
  if (collapsible) {
    const items = Children.toArray(children);
    const head = items[0];
    const rest = items.slice(1);
    const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
    body = (
      <>
        <div
          className="flex items-center gap-2 cursor-pointer select-none"
          onClick={toggle}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <Chevron
            className="w-3 h-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">{head}</div>
        </div>
        {expanded && rest}
      </>
    );
  }

  // Default Card now reads as a band — marker bar on the left, no enclosure.
  // Variants:
  //   glow    → highlighted band with primary marker
  //   subtle  → quiet section with just internal padding & breathable spacing
  //   frame   → opt-in enclosed frame for cases that genuinely need walls
  if (variant === "frame") {
    return <div className="ui-frame p-4 space-y-2.5">{body}</div>;
  }
  if (variant === "subtle") {
    // Used heavily by plugins for choice grids — needs comfortable padding
    // and inter-child spacing or the content reads as a wall of text.
    return (
      <div className="px-3 py-3 space-y-2 border-l-2 border-[var(--rule-color)] hover:border-[var(--accent-primary)] transition-colors">
        {body}
      </div>
    );
  }
  return (
    <div
      className="ui-band space-y-2"
      data-tone={variant === "glow" ? undefined : "muted"}
    >
      {body}
    </div>
  );
};

export const CardList: ComponentRenderer = ({ children }) => {
  return <div className="space-y-2">{children}</div>;
};

export const EntryCard: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  const category = (element.props?.category as string) ?? "";
  const content = resolve(element.props?.content);
  const tags = element.props?.tags as string[] | undefined;
  const rarity = (element.props?.rarity as string) ?? "common";
  // Optional plugin-supplied per-category icon + color (e.g. from a
  // plugin's categoryMeta payload). When provided they override the
  // built-in fallback map below; when missing the card still renders
  // sensibly via the fallback so pre-enrichment entries keep working.
  const externalIcon = element.props?.icon as string | undefined;
  const externalColor = element.props?.color as string | undefined;
  // Generic feature flags — any plugin can set these via itemLiteralProps
  // or itemPropMap. collapsible toggles a chevron that hides body/tags;
  // isNew renders a purple "NEW" sparkle next to the title.
  const collapsible = (element.props?.collapsible as boolean) ?? false;
  const defaultExpanded = (element.props?.defaultExpanded as boolean) ?? true;
  const isNew = (element.props?.isNew as boolean) ?? false;
  // isActive renders a green "active" chip — generic, any plugin can map it
  // (e.g. the currently-bound player voice). Distinct from isNew.
  const isActive = (element.props?.isActive as boolean) ?? false;

  const { expanded, toggle } = useCollapsible(defaultExpanded);

  const CategoryIcon = resolveIcon(
    externalIcon ?? categoryIcons[category] ?? "book-open",
  );
  const iconColorClass = externalColor
    ? `${categoryIconColors[externalColor] ?? "text-primary"}`
    : "text-primary";
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
  const SparkleIcon = Icons.Sparkles;
  const ActiveIcon = Icons.CircleCheck ?? Icons.Check;

  const showBody = !collapsible || expanded;
  const titleRowClass = clsx(
    "flex items-center gap-2",
    collapsible && "cursor-pointer select-none",
  );

  return (
    <div
      className="ui-band space-y-2"
      data-tone={rarityTone[rarity] ?? "muted"}
      style={{ ["--tw-band-marker" as string]: rarityMarkerColor[rarity] }}
    >
      <div
        className={titleRowClass}
        onClick={collapsible ? toggle : undefined}
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
      >
        {collapsible && (
          <Chevron
            className="w-3 h-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        {CategoryIcon && (
          <CategoryIcon
            className={clsx("w-3.5 h-3.5 shrink-0", iconColorClass)}
          />
        )}
        <span className="ui-entry-title text-[13px] font-medium flex-1 truncate text-foreground">
          {title}
        </span>
        {isActive && (
          <span className="ui-chip inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30">
            {ActiveIcon && <ActiveIcon className="w-2.5 h-2.5" />}
            {t("common.active", "Active")}
          </span>
        )}
        {isNew && (
          <span
            className="ui-chip inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase text-purple-600 dark:text-purple-300 bg-purple-500/10 border border-purple-500/30"
            aria-label={t("common.new", "new")}
          >
            <SparkleIcon className="w-2.5 h-2.5" />
            {t("common.newUpper", "NEW")}
          </span>
        )}
        {category && (
          <span
            className={clsx(
              "ui-chip inline-flex items-center px-1.5 py-0.5 text-[10px] border",
              rarityBadgeColors[rarity],
            )}
          >
            {category}
          </span>
        )}
      </div>
      {showBody && content && (
        <p className="text-[12.5px] text-muted-foreground leading-[1.6]">
          {content}
        </p>
      )}
      {showBody && tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="ui-chip text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
