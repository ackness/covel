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

import { useMemo } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import {
  resolveActionParams,
  matchesPendingDraft,
} from "../interaction-selection.js";
import { useSession } from "@/stores/session-store.js";
import { useI18nResolver } from "./helpers.js";

// ── Button ────────────────────────────────────────────────────────
// Kept here: complex standalone, references session store + selection state.

export const Button: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const variant = (element.props?.variant as string) ?? "default";
  const size = (element.props?.size as string) ?? "md";

  // ── Selection feedback for plugin-declared interactions ────────────
  //
  // When the user clicks a plugin-supplied button whose action stashes a
  // pending draft (draftMessage / selectChoice / etc.), we echo the choice
  // back visually so the player can see what they picked. The match is
  // framework-neutral: we only inspect the click binding's params and the
  // active drafts; no plugin IDs anywhere.
  const { state } = useSession();
  const pendingDrafts = state.pendingInteractionDrafts;
  const { get: getState } = useStateStore();
  const isSelected = useMemo(() => {
    if (pendingDrafts.length === 0) return false;
    const click = element.on?.click;
    if (!click) return false;
    const bindings = Array.isArray(click) ? click : [click];
    for (const binding of bindings) {
      const resolved = resolveActionParams(
        binding.params as Record<string, unknown> | undefined,
        getState,
      );
      if (matchesPendingDraft(resolved, pendingDrafts)) return true;
    }
    return false;
  }, [element.on, pendingDrafts, getState]);

  // ── In-flight feedback for plugin-rpc dispatch ─────────────────────
  //
  // PluginPanel writes `/_invoking/<key>` whenever an `invokeRuntime` /
  // `invokePluginAction` click is mid-flight. The button's click binding
  // tells us which key it would set, so we can show a spinner exactly on
  // the button that fired the action — no risk of dimming the whole panel.
  const invokingMap =
    (getState("/_invoking") as Record<string, boolean> | undefined) ?? {};
  const isPending = useMemo(() => {
    const click = element.on?.click;
    if (!click) return false;
    const bindings = Array.isArray(click) ? click : [click];
    for (const binding of bindings) {
      const resolved = resolveActionParams(
        binding.params as Record<string, unknown> | undefined,
        getState,
      );
      if (
        binding.action === "invokeRuntime" &&
        typeof resolved.runtimeId === "string"
      ) {
        if (invokingMap[`runtime:${resolved.runtimeId}`]) return true;
      }
      if (
        binding.action === "invokePluginAction" &&
        typeof resolved.action === "string"
      ) {
        if (invokingMap[`action:${resolved.action}`]) return true;
      }
    }
    return false;
  }, [element.on, invokingMap, getState]);

  const Loader = Icons.Loader2;

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
        "font-medium rounded-[var(--radius-control)] transition-all text-left relative inline-flex items-center gap-1.5",
        size === "compact"
          ? "px-2.5 py-1 text-[11px]"
          : "px-3.5 py-1.5 text-xs",
        !isSelected &&
          variant === "primary" &&
          "bg-foreground text-[var(--surface-page)] hover:bg-foreground/90",
        !isSelected &&
          variant === "default" &&
          "bg-transparent text-foreground border border-border hover:border-foreground/40 hover:bg-foreground/5",
        !isSelected &&
          variant === "ghost" &&
          "bg-transparent text-muted-foreground border border-dashed border-border hover:border-foreground/40 hover:text-foreground",
        !isSelected &&
          variant === "danger" &&
          "bg-[var(--accent-danger)] text-white hover:opacity-90",
        isSelected &&
          "bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)] text-[var(--accent-primary)] border border-[var(--accent-primary)]",
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
