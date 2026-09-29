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
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import { Loader2 } from "lucide-react";
import {
  resolveActionParams,
  matchesPendingDraft,
} from "../interaction-selection.js";
import { useSession } from "@/stores/session-store.js";
import { useI18nResolver } from "./helpers.js";

// ── Button ────────────────────────────────────────────────────────
// Kept here: complex standalone, references session store + selection state.

const invocationParams = new Map<string, readonly [string, string]>([
  ["invokeRuntime", ["runtime", "runtimeId"]],
  ["invokePluginAction", ["action", "action"]],
  ["invokeCommand", ["command", "command"]],
]);

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

  // ── In-flight feedback for plugin-rpc dispatch ─────────────────────
  //
  // PluginPanel writes `/_invoking/<key>` whenever an `invokeRuntime`,
  // `invokePluginAction`, or `invokeCommand` click is mid-flight. The binding
  // tells us which key it would set, so we can show a spinner exactly on
  // the button that fired the action — no risk of dimming the whole panel.
  const invokingMap =
    (getState("/_invoking") as Record<string, boolean> | undefined) ?? {};
  const click = element.on?.click;
  const bindings = click ? (Array.isArray(click) ? click : [click]) : [];
  let isSelected = false;
  let isPending = false;
  // `getState` is stable even when the store changes. Resolve dynamic action
  // params on each render so both feedback states track the current snapshot.
  for (const binding of bindings) {
    const resolved = resolveActionParams(
      binding.params as Record<string, unknown> | undefined,
      getState,
    );
    isSelected ||= matchesPendingDraft(resolved, pendingDrafts);
    const invocation = invocationParams.get(binding.action);
    if (invocation) {
      const [kind, param] = invocation;
      const id = resolved[param];
      isPending ||= typeof id === "string" && !!invokingMap[`${kind}:${id}`];
    }
  }

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
