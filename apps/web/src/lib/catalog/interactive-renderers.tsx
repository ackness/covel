/**
 * interactive-renderers — public re-export barrel.
 *
 * The Button renderer lives here (complex, standalone).
 * Input/Textarea/SearchInput are in interactive-input-renderers.tsx.
 * Select/Switch/FilterBar are in interactive-filter-renderers.tsx.
 * Tabs/createFilterContainer are in interactive-form-renderers.tsx.
 *
 * All symbols remain importable from this path so existing consumers
 * (`lib/catalog.tsx`) continue to work without change.
 */

import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import { Loader2 } from "lucide-react";
import { useI18nResolver } from "./helpers.js";
import { useActionFeedback } from "./use-action-feedback.js";

// ── Button ────────────────────────────────────────────────────────

export const Button: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const variant = (element.props?.variant as string) ?? "default";
  const size = (element.props?.size as string) ?? "md";

  const { isSelected, isPending } = useActionFeedback(element.on?.click);

  const Loader = Loader2;

  return (
    <button
      type="button"
      onClick={() => emit("click")}
      disabled={isPending || undefined}
      aria-pressed={isSelected || undefined}
      aria-busy={isPending || undefined}
      data-selected={isSelected ? "true" : undefined}
      data-pending={isPending ? "true" : undefined}
      className={clsx(
        "font-medium rounded-(--radius-control) transition-all text-left relative inline-flex items-center gap-1.5",
        size === "compact"
          ? "px-2.5 py-1 text-[11px]"
          : "px-3.5 py-1.5 text-xs",
        !isSelected &&
          variant === "primary" &&
          "bg-foreground text-(--surface-page) hover:bg-foreground/90",
        !isSelected &&
          variant === "default" &&
          "bg-transparent text-foreground border border-border hover:border-foreground/40 hover:bg-foreground/5",
        !isSelected &&
          variant === "ghost" &&
          "bg-transparent text-muted-foreground border border-dashed border-border hover:border-foreground/40 hover:text-foreground",
        !isSelected &&
          variant === "danger" &&
          "bg-(--accent-danger) text-white hover:opacity-90",
        isSelected &&
          "bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)] text-(--accent-primary) border border-(--accent-primary)",
        isPending && "opacity-70 cursor-progress",
      )}
    >
      {isPending && (
        <Loader aria-hidden="true" className="w-3 h-3 animate-spin" />
      )}
      {!isPending && isSelected && (
        <span aria-hidden="true" className="inline-block text-primary">
          ✓
        </span>
      )}
      <span>{label}</span>
    </button>
  );
};

// ── Re-exports from sub-modules ────────────────────────────────────
export { Input, Textarea, SearchInput } from "./interactive-input-renderers.js";
export { Select, Switch, FilterBar } from "./interactive-filter-renderers.js";
export { Tabs, createFilterContainer } from "./interactive-form-renderers.js";
